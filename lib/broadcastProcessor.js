// lib/broadcastProcessor.js — NEW (this update)
//
// ⚠️ ARCHITECTURE CHANGE: after FOUR attempts to make Vercel serverless
// functions reliably trigger THEMSELVES to continue a broadcast (bare
// fetch → waitUntil(fetch) → waitUntil with abort → whole-invocation time
// budget), the self-chaining pattern kept dying after exactly one chunk,
// consistently, every single time — never randomly. The first hop
// (triggered by api/bot.js, a fresh invocation with its own full time
// budget) always worked; a function trying to re-trigger ITSELF near the
// end of its own already-mostly-spent budget never reliably did, no
// matter how the timing was tuned. This points to a structural limitation
// of self-triggering on Vercel Hobby, not a tunable timing bug.
//
// New approach: an external free cron pinger (cron-job.org, 1-minute
// granularity, no cost) hits api/broadcastTick.js once a minute. That
// endpoint has no self-triggering logic at all — it just processes
// whatever the current broadcast job's next chunk is and returns. The
// external service is what "continues" the broadcast, not the function
// triggering itself. This is a completely different, load-bearing
// mechanism from anything tried before — not another timing tweak.
//
// This file holds the actual per-chunk processing logic, shared by:
//   - api/broadcastWorker.js — manual, admin-triggered, requires a specific jobId
//   - api/broadcastTick.js   — cron-triggered, auto-picks whatever job is running
// so the two entry points can't drift out of sync with each other.

import { connectToDatabase } from './mongodb.js';
import { tgSend, tgSendPhoto } from './telegram.js';
import { tryLockJob, updateJobProgress, markJobDone, BROADCAST_MSG_DELAY_MS } from './broadcastJob.js';

const ADMIN_ID = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID);

// Ek chunk-e budget-er moddhe ~100-400 message jay, tai 500 ta user ek-sathe porar dorkar nei.
const CANDIDATE_BATCH_SIZE = 250;
// Deliberately conservative — Vercel Hobby's real cutoff is ~10s; this
// stays comfortably under it, measured from the true top of the call
// (before any DB work), not just the send loop.
// Env BROADCAST_BUDGET_MS diye barano jay (vercel.json maxDuration=30 hole 20000 porjonto safe) — beshi = kom invocation.
const TOTAL_BUDGET_MS = Math.min(Number(process.env.BROADCAST_BUDGET_MS) || 8000, 25000);
// Reserved for updateJobProgress's DB write, guaranteed available no
// matter how long the DB overhead up front ends up taking.
const WRAPUP_RESERVE_MS = 1500;

// Processes one chunk of `jobId`. Returns a plain result object — callers
// decide how to respond to their own request.
export async function processBroadcastChunk(jobId) {
    const FUNCTION_START = Date.now();

    const job = await tryLockJob(jobId);
    if (!job) {
        // Either the job doesn't exist, already finished, or another
        // invocation currently holds the lock — nothing to do here.
        return { ok: true, skipped: true };
    }

    const { db } = await connectToDatabase();
    const users = db.collection('users');

    // merges the job's optional audienceFilter (see createBroadcastJob
    // in lib/broadcastJob.js) with the pagination cursor. A normal admin
    // broadcast has no audienceFilter, so this is exactly the old `{}`/`{_id:{$gt:...}}`
    // behavior unchanged; a targeted job (e.g. the inactivity reminder) narrows it.
    // ⚡ banned user ar jara bot block korechhe (botBlocked) tader kache pathano API call-i waste — skip.
    const query = {
        ...(job.audienceFilter || {}),
        isBanned: { $ne: true },
        botBlocked: { $ne: true },
        ...(job.lastUserId ? { _id: { $gt: job.lastUserId } } : {}),
    };
    const candidates = await users.find(query, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(CANDIDATE_BATCH_SIZE)
        .toArray();

    if (candidates.length === 0) {
        return finishJob(jobId, job);
    }

    const extra = {};
    if (job.buttonText && job.buttonUrl) {
        extra.reply_markup = { inline_keyboard: [[{ text: job.buttonText, url: job.buttonUrl }]] };
    }

    let sentDelta = 0, failedDelta = 0;
    let lastUserId = job.lastUserId;
    const blockedIds = [];
    const errorCounts = {};
    let completedAll = true;
    const sendDeadline = FUNCTION_START + TOTAL_BUDGET_MS - WRAPUP_RESERVE_MS;

    for (let i = 0; i < candidates.length; i++) {
        const u = candidates[i];
        let r = null;
        try {
            r = job.photoFileId
                ? await tgSendPhoto(u._id, job.photoFileId, job.text, extra)
                : await tgSend(u._id, job.text, extra);
        } catch {
            r = { ok: false, error_code: 0 };
        }

        // tgApi Telegram-er {ok:false} e throw kore na — tai ager version-e fail-o "sent" gona hoto.
        if (r?.ok) {
            sentDelta++;
        } else if (r?.error_code === 429) {
            // Telegram rate-limit — ei user-ke gona hobe na, cursor-o ekhane theme jabe; porer tick-e abar chelbe.
            completedAll = false;
            break;
        } else {
            failedDelta++;
            // 403 (bot block) ba 400 "chat not found"/"deactivated" = ei user-ke ar pathano jabe na — porer broadcast-e skip
            const desc = String(r?.description || '').toLowerCase();
            if (r?.error_code === 403 || (r?.error_code === 400 && (desc.includes('chat not found') || desc.includes('deactivated')))) blockedIds.push(u._id);
            const key = `${r?.error_code ?? 'net'}: ${String(r?.description || r?.error || 'unknown').slice(0, 80)}`;
            errorCounts[key] = (errorCounts[key] || 0) + 1;
        }
        lastUserId = u._id;

        // Current user process howar PORE check — ek invocation-e kom-pokkhe 1 jon jabei.
        if (Date.now() >= sendDeadline) { completedAll = i === candidates.length - 1; break; }
        if (i < candidates.length - 1) await new Promise((r2) => setTimeout(r2, BROADCAST_MSG_DELAY_MS));
    }

    if (blockedIds.length) {
        await db.collection('users').updateMany(
            { _id: { $in: blockedIds } },
            { $set: { botBlocked: true, botBlockedAt: new Date() } }
        ).catch(() => {});
    }

    await updateJobProgress(jobId, { lastUserId, sentDelta, failedDelta });
    if (Object.keys(errorCounts).length) {
        // debug-er jonno: kon error koto bar (broadcastStatus-e dekha jay)
        const inc = Object.fromEntries(Object.entries(errorCounts).map(([k, v]) => [`errors.${k.replace(/[.$]/g, '_')}`, v]));
        await db.collection('broadcastJobs').updateOne({ _id: job._id }, { $inc: inc }).catch(() => {});
    }

    // ⚡ shesh batch (250-er kom) sompurno hole ekhunei done — extra ekta "khali" tick-er invocation lage na.
    if (completedAll && candidates.length < CANDIDATE_BATCH_SIZE) {
        const fresh = { ...job, sentCount: job.sentCount + sentDelta, failedCount: job.failedCount + failedDelta };
        return finishJob(jobId, fresh);
    }

    return { ok: true, sentThisChunk: sentDelta, failedThisChunk: failedDelta, blockedMarked: blockedIds.length };
}

async function finishJob(jobId, job) {
    await markJobDone(jobId);
    if (ADMIN_ID) {
        await tgSend(ADMIN_ID, `✅ <b>Broadcast Done!</b>\n\nSent: <b>${job.sentCount}</b> | Failed: <b>${job.failedCount}</b>`, {
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] },
        }).catch(() => {});
    }
    return { ok: true, done: true, sentCount: job.sentCount, failedCount: job.failedCount };
}
