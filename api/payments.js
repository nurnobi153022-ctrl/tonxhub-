// api/payments.js — ⚠️ MERGED (this update) — Vercel's Hobby/free plan caps
// a project at 12 serverless functions total, and this project was already
// at 11 before any of this TON-payment work. Rather than add 4 new files
// (api/taskcreate.js, api/cron/checkTaskCreateDeposits.js) and blow past
// the cap, they are combined into this ONE file.
// ⚠️ REMOVED (update) — the "Punch Key" (buy a valid referral with TON)
// system was removed completely. Only Create Task payments remain here.
//
// ── user-facing endpoints (called by the Mini App, index.html) ──
//   POST /api/payments   { resource:'taskcreate', action:'create'|'cancel', initData, ... }
//   GET  /api/payments?resource=taskcreate&action=status|myTasks&initData=...&orderId=...
//
// ── cron entry point (called by an EXTERNAL cron service, e.g. cron-job.org —
//    Vercel's own Cron Triggers only run once/day on the Hobby plan, far
//    too slow for a "credited within 1-5 minutes" promise) ──
//   POST|GET /api/payments?cron=checkDeposits
//   Header: Authorization: Bearer <CRON_SECRET>   (ba ?secret=<OPS_SECRET>)
//   ⚡ Notun: eta ekhon /api/cron/tick (api/ops.js) theke-o chole — eki logic, lib/taskCreateCron.js
//   Runs the Create Task on-chain deposit check.

import { connectToDatabase } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { tgSend } from '../lib/telegram.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { guard } from '../lib/guard.js';
import {
    TASK_CREATE_PACKAGES, TASK_CREATE_ORDER_EXPIRY_MINUTES, TASK_CREATE_REWARD_PER_TASK_WTC,
} from '../lib/constants.js';
import { TON_RECEIVE_ADDRESS, randomTonMemo, buildTonDeepLink } from '../lib/tonPay.js';
import { cronAuthorized } from '../lib/opsAuth.js';
import { runTaskCreateCheck, alertAdminThrottled } from '../lib/taskCreateCron.js';
import { escHtml } from '../lib/telegram.js';

const ADMIN_ID = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID);
const TASK_MODERATOR_ID = process.env.TASK_MODERATOR_ID;
// A payment is accepted if it's at least this fraction of the sticker
// price — a small tolerance for any wallet-side rounding of nanoTON.
// ASSUMED 97% (not specified) — tune freely. Shared by both cron checks below.
const MIN_ACCEPT_RATIO = 0.97;

// ════════════════════════════════════════════════════════════════════
// CREATE TASK — a user pays TON to get their OWN task queued for admin
// review, and once approved (api/bot.js "🕐 Pending Review"), it goes live
// in the Exclusive task section. This section NEVER inserts the real task
// itself — that only happens in the cron section further down, once
// payment is independently verified on-chain. Was api/taskcreate.js.
// ════════════════════════════════════════════════════════════════════

const TC_MAX_TITLE_LENGTH = 80;

const tcRandomMemo = () => randomTonMemo('TC');

function tcOrderResponse(order) {
    const deepLink = buildTonDeepLink(order.amountNanoTon, order.memo);
    return {
        ok: true,
        order: {
            id: String(order._id),
            memo: order.memo,
            amountNanoTon: order.amountNanoTon,
            taskCount: order.taskCount,
            address: TON_RECEIVE_ADDRESS,
            status: order.status,
            expiresAt: order.expiresAt,
            deepLink,
        },
    };
}

// Validates + normalizes the task draft the user is paying to publish.
// Mirrors api/bot.js's admin add-task flow's own channelId/url conventions
// exactly (e.g. auto-prefixing '@', deriving the t.me link) so a
// user-created task is indistinguishable in shape from an admin one.
function tcBuildDraft(body) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'missing_fields' };
    if (title.length > TC_MAX_TITLE_LENGTH) return { error: 'title_too_long' };

    const verifyType = body.verifyType === 'api' ? 'api' : (body.verifyType === 'link' ? 'link' : null);
    if (!verifyType) return { error: 'missing_fields' };

    if (verifyType === 'api') {
        let channelUsername = String(body.channelUsername || '').trim().replace(/^@/, '');
        // also accept a pasted https://t.me/<name> link
        const tMeMatch = channelUsername.match(/t\.me\/([a-zA-Z0-9_]+)/);
        if (tMeMatch) channelUsername = tMeMatch[1];
        if (!channelUsername) return { error: 'missing_fields' };
        // FIX F-17: a Telegram username is 5-32 chars of letters/digits/underscore — nothing else may reach channelId/url
        if (!/^[A-Za-z0-9_]{4,32}$/.test(channelUsername)) return { error: 'invalid_channel' };
        const channelId = `@${channelUsername}`;
        return { draft: { title, verifyType, channelId, url: `https://t.me/${channelUsername}` } };
    }

    // verifyType === 'link'
    const url = String(body.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return { error: 'invalid_url' };
    return { draft: { title, verifyType, channelId: null, url } };
}

async function tcHandleCreate(req, res, db) {
    if (!TON_RECEIVE_ADDRESS) {
        console.error('payments/taskcreate create: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    const orders = db.collection('taskCreateOrders');

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const pkg = TASK_CREATE_PACKAGES[String(req.body?.package)];
    if (!pkg) return res.status(400).json({ ok: false, error: 'invalid_package' });

    const { draft, error } = tcBuildDraft(req.body || {});
    if (error) return res.status(400).json({ ok: false, error });

    // ── one pending order per user at a time  ──
    const now = new Date();
    const existing = await orders.findOne({ userId, status: 'pending', expiresAt: { $gt: now } });
    if (existing) return res.status(200).json(tcOrderResponse(existing));

    const expiresAt = new Date(now.getTime() + TASK_CREATE_ORDER_EXPIRY_MINUTES * 60 * 1000);

    let order = null;
    for (let attempt = 0; attempt < 3 && !order; attempt++) {
        try {
            const doc = {
                userId,
                memo: tcRandomMemo(),
                package: String(req.body.package),
                taskCount: pkg.taskCount,
                amountNanoTon: pkg.priceNanoTon,
                draft,
                status: 'pending',
                createdAt: now,
                expiresAt,
            };
            const result = await orders.insertOne(doc);
            order = { ...doc, _id: result.insertedId };
        } catch (e) {
            if (e?.code === 11000 && attempt < 2) continue; // duplicate memo — retry with a fresh one
            throw e;
        }
    }
    if (!order) return res.status(500).json({ ok: false, error: 'server_error' });

    return res.status(200).json(tcOrderResponse(order));
}

async function tcHandleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    const order = await db.collection('taskCreateOrders').findOne({ _id: objId, userId });
    if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });

    return res.status(200).json({ ok: true, status: order.status, expiresAt: order.expiresAt });
}

async function tcHandleCancel(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    // ⚠️ same caveat as any cancelled order — a late payment against a
    // cancelled order is NOT auto-credited, the frontend warns about this.
    await db.collection('taskCreateOrders').updateOne(
        { _id: objId, userId, status: 'pending' },
        { $set: { status: 'expired', expiredAt: new Date(), cancelledByUser: true } }
    );
    return res.status(200).json({ ok: true });
}

async function tcHandleMyTasks(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const taskDocs = await db.collection('tasks')
        .find({ createdBy: userId, isUserCreated: true })
        .project({ title: 1, limit: 1, completionCount: 1, createdAt: 1, completedAt: 1, category: 1, isApproved: 1, reviewStatus: 1 })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

    return res.status(200).json({ ok: true, tasks: taskDocs });
}

async function taskcreateRouter(req, res, db) {
    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'create') return tcHandleCreate(req, res, db);
        if (action === 'cancel') return tcHandleCancel(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return tcHandleStatus(req, res, db);
        if (action === 'myTasks') return tcHandleMyTasks(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

// ════════════════════════════════════════════════════════════════════
// CRON — verifies Create Task TON payments ON-CHAIN. Nothing about a payment is ever trusted from the client — this
// is the ONLY place a taskCreateOrders doc is ever allowed
// to flip 'pending' → 'paid'. Was api/cron/checkPunchKeyDeposits.js +
// api/cron/checkTaskCreateDeposits.js.
//
// No separate "already-processed transaction" table is needed for either
// half — the atomic status:'pending'→'paid' gate on each ORDER itself is
// what prevents double-crediting (same pattern as the atomic gates in
// lib/referral.js).
// ════════════════════════════════════════════════════════════════════

async function handleCronCheckDeposits(req, res, db) {
    // Auth: CRON_SECRET (Vercel Cron / cron-job.org Bearer) ba OPS_SECRET/BOT_TOKEN (?secret= ba Bearer).
    // Kono secret-i set na thakle legacy-r moto open thake (idempotent), kintu warning dey — OPS_SECRET set korun.
    if (process.env.CRON_SECRET || process.env.OPS_SECRET) {
        if (!cronAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    } else {
        console.warn('payments cron checkDeposits: no CRON_SECRET/OPS_SECRET set — endpoint is open');
    }
    if (!TON_RECEIVE_ADDRESS) {
        console.error('payments cron checkDeposits: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }

    try {
        const taskCreate = await runTaskCreateCheck(db);
        return res.status(200).json({ ok: true, taskCreate });
    } catch (err) {
        console.error('payments cron checkDeposits error:', err);
        await alertAdminThrottled(db, `🚨 <b>TON Deposit Check FAILED</b>\n\n<code>${escHtml(String(err?.message || err).slice(0, 500))}</code>`);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}

// ════════════════════════════════════════════════════════════════════
// TOP-LEVEL DISPATCH
// ════════════════════════════════════════════════════════════════════

async function handlerImpl(req, res) {
    // 🛡️ Server Guard (3 layers) — user traffic only; the cron call has its own auth and no Telegram session
    if (!req.query?.cron && await guard(req, res)) return;

    const { db } = await connectToDatabase();

    // ── cron: POST /api/payments?cron=checkDeposits ──
    if ((req.method === 'POST' || req.method === 'GET') && req.query.cron === 'checkDeposits') {
        return handleCronCheckDeposits(req, res, db);
    }

    // ── user-facing: dispatched by `resource` (body for POST, query for GET) ──
    const resource = req.method === 'GET' ? req.query.resource : req.body?.resource;
    if (resource === 'taskcreate') return taskcreateRouter(req, res, db);
    return res.status(400).json({ ok: false, error: 'unknown_resource' });
}

// FIX F-16: safety net — an unexpected error (e.g. the database being unreachable on the free tier) now returns a
// clean JSON 500 instead of a platform crash page; nothing internal is sent to the client.
export default async function handler(req, res) {
    try {
        return await handlerImpl(req, res);
    } catch (e) {
        console.error('payments handler error:', e?.message);
        if (!res.headersSent) return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
