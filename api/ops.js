// api/ops.js — ALL admin / broadcast / cron endpoints in ONE serverless function
//
// Why: Vercel Hobby allows max 12 serverless functions per project. This file
// replaces 7 separate files (broadcastWorker, broadcastStatus, broadcastTick,
// admin/check-chats, admin/set-webhook, admin/setup-indexes, cron/weeklyReferral).
//
// The OLD URLs still work unchanged — vercel.json rewrites them here:
//   /api/broadcastWorker        -> /api/ops?op=broadcastWorker
//   /api/broadcastStatus        -> /api/ops?op=broadcastStatus
//   /api/broadcastTick          -> /api/ops?op=broadcastTick   (cron-job.org, every 1 min)
//   /api/admin/check-chats      -> /api/ops?op=check-chats
//   /api/admin/set-webhook      -> /api/ops?op=set-webhook
//   /api/admin/setup-indexes    -> /api/ops?op=setup-indexes
//   /api/cron/weeklyReferral    -> /api/ops?op=weeklyReferral
// You can also call /api/ops?op=<name>&... directly.

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, OFFICIAL_CHANNEL, COMMUNITY_GROUP, PAYMENT_PROOF_GROUP } from '../lib/telegram.js';
import { getLatestBroadcastJob, createBroadcastJob } from '../lib/broadcastJob.js';
import { processBroadcastChunk } from '../lib/broadcastProcessor.js';
import { WEEKLY_REFERRAL_MIN_COUNT, WEEKLY_REFERRAL_MAX_WINNERS } from '../lib/constants.js';
import { opsAuthorized } from '../lib/opsAuth.js';
import { handleAdsgramReward } from '../lib/adsgramS2S.js';

const BOT_TOKEN = process.env.BOT_TOKEN;

// shared Telegram Bot API helper (used by check-chats + set-webhook)
async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return r.json();
}


// ═══════════════════════════════════════════════════════════════
// op=broadcastWorker   (was api/broadcastWorker.js)
// ═══════════════════════════════════════════════════════════════
// api/broadcastWorker.js — ⚠️ SIMPLIFIED (this update)
//
// Manually processes ONE chunk of a SPECIFIC broadcast job. No longer
// self-triggers the next chunk (that pattern was tried four different ways
// and never reliably worked on Vercel Hobby — see lib/broadcastProcessor.js
// for the full story). Continuing a broadcast automatically is now the
// job of api/broadcastTick.js, called every minute by an external free
// cron service (cron-job.org). This endpoint remains for:
//   - api/bot.js's one-time kick right after a broadcast is queued (gets
//     the first chunk out immediately instead of waiting up to a minute
//     for the next cron tick)
//   - manually nudging a specific job forward from a browser if needed
//
// GET/POST /api/broadcastWorker?jobId=...&secret=<BOT_TOKEN>



async function opBroadcastWorker(req, res) {
    if (!opsAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ ok: false, error: 'missing_job_id' });

    const result = await processBroadcastChunk(jobId);
    return res.status(200).json(result);
}

// ═══════════════════════════════════════════════════════════════
// op=broadcastStatus   (was api/broadcastStatus.js)
// ═══════════════════════════════════════════════════════════════
// api/broadcastStatus.js — NEW
//
// Lets the admin check a broadcast's real progress (sentCount / totalUsers,
// status, how far the cursor has gotten) instead of guessing from whether a
// specific test account has received it yet — a large broadcast can take
// several minutes to reach every user, and any single account (especially a
// recently-created admin test account near the end of the sorted list) may
// simply not have been reached yet even while the job is progressing fine.
//
// GET /api/broadcastStatus?secret=<BOT_TOKEN>
// Visit from a browser exactly like /api/admin/setup-indexes.



async function opBroadcastStatus(req, res) {
    if (!opsAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const job = await getLatestBroadcastJob();
    if (!job) return res.status(200).json({ ok: true, message: 'No broadcast jobs found yet.' });

    const percent = job.totalUsers ? Math.round((job.sentCount + job.failedCount) / job.totalUsers * 100) : 0;

    return res.status(200).json({
        ok: true,
        status: job.status,
        progress: `${job.sentCount + job.failedCount} / ${job.totalUsers} (${percent}%)`,
        sentCount: job.sentCount,
        failedCount: job.failedCount,
        totalUsers: job.totalUsers,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        // If status is 'running'/'pending' and updatedAt is more than ~30s
        // old, the self-trigger chain has likely stalled (e.g. a network
        // hiccup between hops) — re-visiting the worker URL below with this
        // jobId manually resumes it from exactly where it left off.
        resumeUrl: job.status !== 'done' ? `/api/broadcastWorker?jobId=${job._id}&secret=<BOT_TOKEN>` : null,
    });
}

// ═══════════════════════════════════════════════════════════════
// op=broadcastTick   (was api/broadcastTick.js)
// ═══════════════════════════════════════════════════════════════
// api/broadcastTick.js — UPDATED (this update)
//
// This is what actually keeps a broadcast moving — see
// lib/broadcastProcessor.js for why self-triggering was abandoned.
//
// No jobId needed: picks whatever the most recent broadcast job is, and if
// it isn't finished yet, processes its next chunk. If there's no job or the
// latest one is already done, it now ALSO checks whether the 12-hour "Daily
// Complete Ads Earn" auto-reminder is due — if so it queues that as a new
// broadcast job right here. Otherwise this is a harmless no-op.
//
// GET /api/broadcastTick?secret=<BOT_TOKEN>
//
// ⚠️ SETUP REQUIRED (one-time, outside this codebase): point a free
// external cron service at this URL, running every 1 minute, indefinitely.
// cron-job.org (free, no cost, 1-minute granularity) is a good option:
//   1. Sign up free at https://cron-job.org
//   2. Create a new cronjob:
//      URL: https://tonxhub.vercel.app/api/broadcastTick?secret=<BOT_TOKEN>
//      Schedule: every 1 minute
//   3. Save and enable it — leave it running permanently.
// Once set up, every broadcast queued from the admin panel will keep
// getting nudged forward automatically, a chunk at a time, until done —
// no manual visits needed, regardless of how many users there are.
//
// ⚠️ MERGED IN (this update) — the 12h auto-reminder used to be planned as
// its own new file (api/cron/autoEarnReminder.js), but Vercel's Hobby plan
// caps a project at 12 serverless functions total, and this project was
// already sitting at exactly 12. Adding a 13th file would have broken the
// whole deployment. Since this endpoint is ALREADY pinged every 1 minute
// by the external cron-job.org job (see setup above), the reminder check
// piggybacks on that SAME ping instead of needing its own separate cron —
// no new cron-job.org entry needed at all.
//
// The reminder only fires when NO broadcast is currently running (never
// stacks a new job on top of an in-progress one — see the comment below),
// and it self-throttles via a stored `lastSentAt` timestamp in the
// `settings` collection, so being pinged every minute is harmless — it
// only actually queues+sends once every 12 hours.


const MINI_APP_URL = 'https://t.me/tonxhubEarn_bot'; // ⚠️ must match api/bot.js's MINI_APP_URL

const REMINDER_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ✏️ ROTATING CAPTIONS (update) — the 12-hour reminder now cycles through these
// captions in order: 1st broadcast uses caption #1, the next one (12h later)
// caption #2, … and after the last one it starts again from #1. Edit / add /
// remove captions freely (any number from 1 up; the position is saved in the
// `settings` collection → autoEarnReminder.captionIndex).
const REMINDER_CAPTIONS = [
    `🎬 <b>Daily Complete Ads Earn 0.1$!</b>\n\n` +
    `Don't miss out on today's earning — your daily rewards are open right now and they reset at midnight!\n\n` +
    `1️⃣ First, complete your <b>Tasks</b> ✅ — every task pays TXH COIN straight to your balance.\n` +
    `2️⃣ Then <b>play games</b> 🎮 and <b>spin the wheel</b> 🎡 for bonus rewards.\n` +
    `3️⃣ Finally, <b>watch your daily ads</b> 📺 and claim your reward.\n\n` +
    `💡 Complete all of it every day and your balance keeps growing — small steps, real money.\n\n` +
    `👇 Open the App now and get started:`,

    `💰 <b>Your TXH COIN is waiting for you!</b>\n\n` +
    `Your balance doesn't grow while the app is closed — but it grows fast when you're in!\n\n` +
    `🎮 Play games and earn rewards\n` +
    `✅ Finish tasks for instant TXH COIN\n` +
    `🎡 Spin the wheel for bonus rewards\n` +
    `📺 Watch ads to unlock extra earnings\n\n` +
    `Every minute you spend today brings you closer to your next withdrawal. Why wait?\n\n` +
    `👇 Tap below and keep earning:`,

    `🔥 <b>Don't break your streak!</b>\n\n` +
    `Your daily streak reward gets bigger every consecutive day — but only if you show up. Miss a day and it starts over from zero!\n\n` +
    `Right now you can:\n` +
    `🔥 Claim today's streak reward\n` +
    `📺 Watch your daily ads\n` +
    `🎮 Play a game or two\n\n` +
    `It takes just a few minutes, and the reward is worth it. Protect your streak today!\n\n` +
    `👇 Open TON X HUB now:`,

    `🎡 <b>Free spins are ready!</b>\n\n` +
    `The wheel is waiting — every spin can drop bonus TXH COIN straight into your balance.\n\n` +
    `Here's your quick plan for today:\n` +
    `1️⃣ Spin the wheel 🎡\n` +
    `2️⃣ Complete your tasks ✅\n` +
    `3️⃣ Watch your daily ads 📺\n\n` +
    `Do these steps regularly and you'll unlock your next withdrawal sooner than you think. 💸\n\n` +
    `👇 Spin & earn now:`,

    `👥 <b>Invite friends, earn more!</b>\n\n` +
    `Did you know your friends can make your earnings grow too?\n\n` +
    `🎁 You get TXH COIN rewards at every step your friend completes\n` +
    `✅ A friend who finishes all the steps becomes a <b>Valid Referral</b>\n` +
    `💸 Valid referrals unlock bigger withdrawals for you\n` +
    `🤝 And you earn a commission every time they withdraw\n\n` +
    `Share your personal link with friends and family today — the more people you invite, the more you earn.\n\n` +
    `👇 Open the app and copy your referral link:`,

    `⏰ <b>12 hours passed — time to earn again!</b>\n\n` +
    `Your daily tasks, games and ads are open and waiting for you. Don't let today's rewards go unclaimed!\n\n` +
    `📋 Your checklist:\n` +
    `✅ Complete your tasks\n` +
    `🎮 Play games\n` +
    `📺 Watch your daily ads\n` +
    `🎡 Do your spins\n\n` +
    `Finish them all and you'll be ready to withdraw. Consistency is what turns small rewards into real cash. 💵\n\n` +
    `👇 Open the App:`,
];

async function opBroadcastTick(req, res) {
    if (!opsAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const job = await getLatestBroadcastJob();

    if (job && job.status !== 'done') {
        // একটা broadcast (manual admin broadcast হোক বা auto-reminder) already
        // চলছে — সেটাই চালিয়ে যাও, নতুন কিছু চেক করার দরকার নেই এই tick-এ।
        const result = await processBroadcastChunk(String(job._id));
        return res.status(200).json({ ...result, jobId: String(job._id) });
    }

    // কোনো broadcast এই মুহূর্তে চলছে না (হয় কখনো হয়নি, নয়তো শেষ হয়ে গেছে) —
    // তাহলে দেখো auto-reminder-এর পালা এসেছে কিনা।
    const { db } = await connectToDatabase();
    const settings = db.collection('settings');
    const state = await settings.findOne({ _id: 'autoEarnReminder' });
    const now = Date.now();
    const lastSentAt = state?.lastSentAt ? new Date(state.lastSentAt).getTime() : 0;

    if (now - lastSentAt < REMINDER_INTERVAL_MS) {
        // এখনো 12h পার হয়নি — সত্যিকারের harmless idle tick।
        return res.status(200).json({ ok: true, idle: true });
    }

    const users = db.collection('users');
    const totalUsers = await users.countDocuments({});

    // pick the next caption in rotation (saved position + 1 each time).
    const captionIndex = (Number(state?.captionIndex) || 0) % REMINDER_CAPTIONS.length;

    const newJob = await createBroadcastJob({
        text: REMINDER_CAPTIONS[captionIndex],
        buttonText: '🚀 Open TON X HUB',
        buttonUrl: MINI_APP_URL,
        photoFileId: null,
        createdBy: 'auto-cron-12h',
        totalUsers,
    });

    // lastSentAt সাথে সাথেই lock করে ফেলা হচ্ছে (job তৈরির পরপরই) — পরের
    // মিনিটের tick এসে দ্বিতীয়বার নতুন job বানানো আটকাবে (তখন getLatestBroadcastJob
    // এই নতুন job-টাই ফেরত দেবে, status 'done' না হওয়া পর্যন্ত উপরের ব্লকেই ঢুকবে)।
    await settings.updateOne(
        { _id: 'autoEarnReminder' },
        { $set: { lastSentAt: new Date(now), captionIndex: (captionIndex + 1) % REMINDER_CAPTIONS.length } },
        { upsert: true }
    );

    const result = await processBroadcastChunk(String(newJob._id));
    return res.status(200).json({ ...result, jobId: String(newJob._id), autoReminder: true, caption: captionIndex + 1 });
}

// ═══════════════════════════════════════════════════════════════
// op=check-chats   (was api/admin/check-chats.js)
// ═══════════════════════════════════════════════════════════════
// api/admin/check-chats.js — NEW (diagnostic)
//
// "সব চ্যানেলে জয়েন আছে তবুও জয়েন নেই দেখায়" সমস্যার কারণ খুঁজে বের করে।
// কোড যে চ্যানেল/গ্রুপ ID গুলো দিয়ে চেক করে, সেগুলোর প্রতিটার জন্য দেখায়:
//   - চ্যাটটা Telegram এ আছে কিনা (নাম কী)
//   - বট ওই চ্যাটে অ্যাডমিন কিনা
//   - তোমার (user) স্ট্যাটাস কী
//
// ব্যবহার:
//   https://tonxhub.vercel.app/api/admin/check-chats?secret=<BOT_TOKEN>&user=<তোমার Telegram ID>




async function opCheckChats(req, res) {
    if (!opsAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
        const me = await tg('getMe');
        const botId = me?.result?.id;
        const userId = req.query.user ? Number(req.query.user) : null;

        const targets = {
            OFFICIAL_CHANNEL,
            COMMUNITY_GROUP,
            PAYMENT_PROOF_GROUP,
        };

        const out = {};
        for (const [label, chatId] of Object.entries(targets)) {
            const chat = await tg('getChat', { chat_id: chatId });
            const botMember = botId ? await tg('getChatMember', { chat_id: chatId, user_id: botId }) : null;
            const userMember = userId ? await tg('getChatMember', { chat_id: chatId, user_id: userId }) : null;
            out[label] = {
                checked_id: chatId,
                chat: chat.ok ? { title: chat.result.title, type: chat.result.type } : { error: chat.description },
                bot_status: botMember ? (botMember.ok ? botMember.result.status : { error: botMember.description }) : 'n/a',
                user_status: userMember ? (userMember.ok ? userMember.result.status : { error: userMember.description }) : 'pass &user=<id>',
            };
        }
        return res.status(200).json({ ok: true, bot: me?.result?.username, chats: out });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || 'failed' });
    }
}

// ═══════════════════════════════════════════════════════════════
// op=set-webhook   (was api/admin/set-webhook.js)
// ═══════════════════════════════════════════════════════════════
// api/admin/set-webhook.js — NEW
//
// নতুন প্রজেক্ট / নতুন Vercel ডোমেইনের জন্য Telegram webhook রেজিস্টার করে।
// setup-indexes.js এর মতোই: ব্রাউজারে একটা URL খুলে GET request পাঠালেই কাজ হয়।
//
// ব্যবহার (deploy হওয়ার পর, মোবাইল Chrome এ):
//   https://tonxhub.vercel.app/api/admin/set-webhook?secret=<BOT_TOKEN>
//
// অতিরিক্ত অপশন:
//   &drop=1   → পুরনো জমে থাকা pending update ফেলে দেয় (নতুন বটে পুরনো মেসেজ আসবে না)
//   &info=1   → শুধু বর্তমান webhook এর অবস্থা দেখায়, কিছু বদলায় না
//   &delete=1 → webhook মুছে দেয়
//
// ⚠️ আগে Vercel env এ এই দুটো সেট থাকতে হবে (তারপর Redeploy):
//   BOT_TOKEN                  — নতুন বটের টোকেন
//   TELEGRAM_WEBHOOK_SECRET    — যেকোনো লম্বা random string (শুধু A-Z a-z 0-9 _ -, ১-২৫৬ অক্ষর)
// api/bot.js এই secret না মিললে সব রিকোয়েস্ট 401 দিয়ে ফেরত দেয়, তাই
// setWebhook এ একই secret পাঠানো হয়।
//
// SECURITY: setup-indexes.js এর মতো BOT_TOKEN-ই shared-secret। ভুল/অনুপস্থিত হলে 401।
// bot.js শুধু message আর callback_query ব্যবহার করে, তাই allowed_updates সেটাই।

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// নতুন Vercel ডোমেইন বদলালে শুধু এই লাইনটা বদলান
const APP_URL = 'https://tonxhub.vercel.app';
const WEBHOOK_URL = `${APP_URL}/api/bot`;


// token ফাঁস না হয় এজন্য রেসপন্স থেকে সরিয়ে দেওয়া
const safeInfo = (info) => {
    const r = info?.result || {};
    return {
        url: r.url,
        pending_update_count: r.pending_update_count,
        last_error_date: r.last_error_date,
        last_error_message: r.last_error_message,
        allowed_updates: r.allowed_updates,
    };
};

async function opSetWebhook(req, res) {
    if (!opsAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    try {
        if (req.query.info === '1') {
            return res.status(200).json({ ok: true, webhook: safeInfo(await tg('getWebhookInfo')) });
        }

        if (req.query.delete === '1') {
            const del = await tg('deleteWebhook', { drop_pending_updates: req.query.drop === '1' });
            return res.status(200).json({ ok: !!del.ok, deleted: del });
        }

        if (!WEBHOOK_SECRET) {
            return res.status(500).json({
                ok: false,
                error: 'TELEGRAM_WEBHOOK_SECRET Vercel env এ সেট করা নেই। সেট করে Redeploy করুন, তারপর আবার খুলুন।',
            });
        }
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
            return res.status(500).json({
                ok: false,
                error: 'TELEGRAM_WEBHOOK_SECRET এ শুধু A-Z a-z 0-9 _ - ব্যবহার করা যাবে (১-২৫৬ অক্ষর)।',
            });
        }

        const set = await tg('setWebhook', {
            url: WEBHOOK_URL,
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: req.query.drop === '1',
            max_connections: 40,
        });

        const info = await tg('getWebhookInfo');
        return res.status(set.ok ? 200 : 502).json({
            ok: !!set.ok,
            setWebhook: set,
            webhook: safeInfo(info),
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || 'failed' });
    }
}

// ═══════════════════════════════════════════════════════════════
// op=setup-indexes   (was api/admin/setup-indexes.js)
// ═══════════════════════════════════════════════════════════════
// api/admin/setup-indexes.js — NEW
//
// আপনার mobile-only setup এ `node models/schema.js` চালানোর কোনো উপায় নেই
// (terminal/Node.js নেই)। তাই এই endpoint টা ঠিক একই index-creation কোড
// চালায়, কিন্তু শুধু একটা browser এ URL খুলে GET request পাঠিয়েই ট্রিগার
// করা যায়।
//
// ব্যবহার (deploy হওয়ার পর, মোবাইল Chrome এ):
//   https://<your-vercel-domain>/api/admin/setup-indexes?secret=<your BOT_TOKEN>
//
// ⚠️ SECURITY: BOT_TOKEN ইতিমধ্যে আপনার Vercel env এ secret হিসেবে সেভ করা
// আছে এবং কখনো ইউজারের কাছে পাঠানো হয় না — তাই এটাকেই এখানে shared-secret
// হিসেবে reuse করা হচ্ছে, আলাদা কোনো নতুন env variable যোগ করার দরকার নেই।
// ভুল/অনুপস্থিত secret দিলে 401 ফেরত আসবে, কিছু চলবে না।
//
// createIndex সবসময় idempotent — একই index বারবার বানাতে চাইলেও দ্বিতীয়
// বার থেকে MongoDB চুপচাপ কিছু করে না (already exists), তাই এই endpoint
// বারবার visit করলেও কোনো ক্ষতি নেই — safe to re-run anytime after future
// schema changes too.



async function opSetupIndexes(req, res) {
    if (!opsAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const results = [];
    try {
        const { db } = await connectToDatabase();

        const steps = [
            ['users.referredBy', () => db.collection('users').createIndex({ referredBy: 1 })],
            ['users.isBanned', () => db.collection('users').createIndex({ isBanned: 1 })],
            ['users.weeklyReferralCount', () => db.collection('users').createIndex({ weeklyReferralCount: -1 })],
            // Leaderboard (api/data.js), admin Top Referrers (bot.js) and the weekly report sort by referralCount;
            // createdAt backs the admin "All Users" paged list. Without these each call scans + sorts all users.
            ['users.referralCount', () => db.collection('users').createIndex({ referralCount: -1 })],
            ['users.createdAt', () => db.collection('users').createIndex({ createdAt: -1 })],
            ['users.bannedAt (partial TTL 60d, isBanned:true only)', () => db.collection('users').createIndex(
                { bannedAt: 1 },
                { expireAfterSeconds: 5184000, partialFilterExpression: { isBanned: true } }
            )],
            ['videos.isActive+createdAt', () => db.collection('videos').createIndex({ isActive: 1, createdAt: -1 })],
            // 🎮 NEW — Games section (permanent collection, so no TTL — just lookup indexes)
            ['games.isActive+createdAt', () => db.collection('games').createIndex({ isActive: 1, createdAt: -1 })],
            ['games.gameUrl', () => db.collection('games').createIndex({ gameUrl: 1 })],
            ['tasks.isApproved+category+createdAt', () => db.collection('tasks').createIndex({ isApproved: 1, category: 1, createdAt: -1 })],
            ['dailyClaims.userId+createdAt', () => db.collection('dailyClaims').createIndex({ userId: 1, createdAt: -1 })],
            ['withdrawals.userId+createdAt', () => db.collection('withdrawals').createIndex({ userId: 1, createdAt: -1 })],
            ['withdrawals.details', () => db.collection('withdrawals').createIndex({ details: 1 })],
            ['promos.code (unique)', () => db.collection('promos').createIndex({ code: 1 }, { unique: true })],
            ['promos.expiresAt (TTL)', () => db.collection('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })],
            // the two cleanup indexes for this update
            ['fingerprints.lastSeenAt (TTL 180d)', () => db.collection('fingerprints').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 15552000 })],
            ['gifts.claimedAt (partial TTL 30d, status:claimed only)', () => db.collection('gifts').createIndex(
                { claimedAt: 1 },
                { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'claimed' } }
            )],
            // spin history: TTL 30 days (2592000s) + lookup index for the admin user panel
            ['spinLogs.createdAt (TTL 30d)', () => db.collection('spinLogs').createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 })],
            ['spinLogs.userId+createdAt', () => db.collection('spinLogs').createIndex({ userId: 1, createdAt: -1 })],
            // withdrawal requirement (rolling 24h ads): rows only matter for 24h; kept 3 days then auto-deleted
            ['adCompletions.userId+createdAt', () => db.collection('adCompletions').createIndex({ userId: 1, createdAt: -1 })],
            ['adCompletions.createdAt (TTL 3d)', () => db.collection('adCompletions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 259200 })],
            // Mini Bot run history: TTL 30 days
            // 🛡️ Server Guard (lib/guard.js) — counters + temp blocks, self-cleaning
            ['rateLimits.expireAt (TTL)', () => db.collection('rateLimits').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })],
            ['rateBlocks.expireAt (TTL)', () => db.collection('rateBlocks').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })],
            ['miniBotLogs.createdAt (TTL 30d)', () => db.collection('miniBotLogs').createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 })],
            ['miniBotLogs.userId+createdAt', () => db.collection('miniBotLogs').createIndex({ userId: 1, createdAt: -1 })],
            ['weeklyReferralReports.weekEndedAt', () => db.collection('weeklyReferralReports').createIndex({ weekEndedAt: -1 })],
            ['adminState.updatedAt (TTL 1h)', () => db.collection('adminState').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 3600 })],
            // resumable broadcast jobs (lib/broadcastJob.js). One doc
            // per broadcast campaign, auto-cleaned 30 days after it finishes.
            ['broadcastJobs.finishedAt (partial TTL 30d, status:done only)', () => db.collection('broadcastJobs').createIndex(
                { finishedAt: 1 },
                { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'done' } }
            )],
            // Create Task (api/payments.js). See
            // models/schema.js's taskCreateOrders collection
            // docs for the full field shapes these indexes support.
            ['taskCreateOrders.memo (unique)', () => db.collection('taskCreateOrders').createIndex({ memo: 1 }, { unique: true })],
            ['taskCreateOrders.userId+status', () => db.collection('taskCreateOrders').createIndex({ userId: 1, status: 1 })],
            ['taskCreateOrders.expiresAt (partial TTL 1h, status:pending only)', () => db.collection('taskCreateOrders').createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 3600, partialFilterExpression: { status: 'pending' } }
            )],
            ['taskCreateOrders.expiredAt (partial TTL 30d, status:expired only)', () => db.collection('taskCreateOrders').createIndex(
                { expiredAt: 1 },
                { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'expired' } }
            )],
            ['tasks.completedAt (partial TTL 5d, isUserCreated:true only)', () => db.collection('tasks').createIndex(
                { completedAt: 1 },
                { expireAfterSeconds: 432000, partialFilterExpression: { isUserCreated: true } }
            )],
            ['tasks.createdBy+isUserCreated+createdAt ("My Created Tasks")', () => db.collection('tasks').createIndex({ createdBy: 1, isUserCreated: 1, createdAt: -1 })],
            ['tasks.isUserCreated+reviewStatus+createdAt ("🕐 Pending Review")', () => db.collection('tasks').createIndex({ isUserCreated: 1, reviewStatus: 1, createdAt: 1 })],
        ];

        for (const [name, fn] of steps) {
            try {
                await fn();
                results.push({ index: name, ok: true });
            } catch (err) {
                // একটা index fail করলেও বাকিগুলো চালিয়ে যাও — partial success useful
                results.push({ index: name, ok: false, error: err.message });
            }
        }

        const failed = results.filter(r => !r.ok);
        return res.status(200).json({ ok: failed.length === 0, results });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message, results });
    }
}

// ═══════════════════════════════════════════════════════════════
// op=weeklyReferral   (was api/cron/weeklyReferral.js)
// ═══════════════════════════════════════════════════════════════
// api/cron/weeklyReferral.js — WEEKLY REFERRAL COMPETITION (OPTIONAL cron)
//
// ⚠️ NOT currently wired into vercel.json — the admin is running this
// manually via bot.js's a_weekly → "🔄 Reset week now" button instead (same
// underlying rule, same weeklyReferralReports collection). This file is kept
// as an optional automatic alternative if the admin later decides they'd
// rather it run itself every Friday instead of tapping a button. To enable:
// add `{ "path": "/api/cron/weeklyReferral", "schedule": "..." }` to
// vercel.json's `crons` array.
//
// Mirrors bot.js's manual flow exactly: only users with AT LEAST
// WEEKLY_REFERRAL_MIN_COUNT referrals this week qualify, top
// WEEKLY_REFERRAL_MAX_WINNERS of those get saved as winners — could be
// fewer than that (even 0) if not enough people crossed the threshold. NO
// automatic TXH COIN payout — winners are saved to `weeklyReferralReports` for
// the admin to review and pay manually (via 📜 Weekly Report in bot.js).
//
// Vercel signs cron invocations with `Authorization: Bearer ${CRON_SECRET}`
// (auto-provisioned by Vercel) — verified below so nobody else can trigger this.


const ADMIN_ID = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID);

async function opWeeklyReferral(req, res) {
    // FIX F-07: fail CLOSED. Previously, with CRON_SECRET unset this endpoint was open to everyone and
    // anyone could reset all weekly referral counters. (The admin's manual "Reset week now" button in
    // api/bot.js is unaffected.)
    const authHeader = req.headers['authorization'];
    if (!process.env.CRON_SECRET) {
        return res.status(503).json({ ok: false, error: 'cron_secret_not_configured' });
    }
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    try {
        const { db } = await connectToDatabase();
        const users = db.collection('users');

        const weekly = await users.find({ weeklyReferralCount: { $gt: 0 }, isBanned: { $ne: true } })
            .sort({ weeklyReferralCount: -1 })
            .limit(20)
            .project({ firstName: 1, telegramUsername: 1, weeklyReferralCount: 1 })
            .toArray();

        const winners = weekly
            .filter(u => u.weeklyReferralCount >= WEEKLY_REFERRAL_MIN_COUNT)
            .slice(0, WEEKLY_REFERRAL_MAX_WINNERS)
            .map(u => ({ userId: u._id, firstName: u.firstName || null, telegramUsername: u.telegramUsername || null, weeklyReferralCount: u.weeklyReferralCount }));

        await db.collection('weeklyReferralReports').insertOne({
            weekEndedAt: new Date(),
            winners,
            totalParticipants: weekly.length,
        });

        await users.updateMany({ weeklyReferralCount: { $ne: 0 } }, { $set: { weeklyReferralCount: 0 } });

        if (ADMIN_ID) {
            const summary = winners.length
                ? winners.map((w, i) => `${i + 1}. @${w.telegramUsername || w.firstName || w.userId} — ${w.weeklyReferralCount} refs`).join('\n')
                : `No winners this week — nobody reached ${WEEKLY_REFERRAL_MIN_COUNT}+ referrals.`;
            await tgSend(ADMIN_ID,
                `📊 <b>Weekly Referral — Auto Report Saved</b>\n\n🏆 ${winners.length} winner(s):\n${summary}\n\n` +
                `Send rewards manually, then check 📜 Weekly Report in the admin panel anytime.\n` +
                `🔄 Everyone's weekly counter has been reset for the new week.`
            ).catch(() => {});
        }

        return res.status(200).json({ ok: true, winners: winners.length });
    } catch (err) {
        console.error('weeklyReferral cron error:', err);
        if (ADMIN_ID) {
            await tgSend(ADMIN_ID, `🚨 <b>Weekly Referral Cron FAILED</b>\n\n<code>${String(err?.message || err)}</code>\n\nWeekly counters were NOT reset — safe to retry.`).catch(() => {});
        }
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}

// ═══════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════
const OPS = {
    'broadcastWorker': opBroadcastWorker,
    'broadcastStatus': opBroadcastStatus,
    'broadcastTick': opBroadcastTick,
    'check-chats': opCheckChats,
    'set-webhook': opSetWebhook,
    'setup-indexes': opSetupIndexes,
    'weeklyReferral': opWeeklyReferral,
    'adsgramReward': handleAdsgramReward, // Adsgram server-to-server Reward URL (lib/adsgramS2S.js)
};

export default async function handler(req, res) {
    const fn = OPS[String(req.query.op || '')];
    if (!fn) return res.status(404).json({ ok: false, error: 'unknown_op', ops: Object.keys(OPS) });
    return fn(req, res);
}
