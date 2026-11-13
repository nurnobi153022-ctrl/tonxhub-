// lib/taskCreateCron.js — "Create Task" on-chain TON payment check (cron logic)
//
// Pehle ei code api/payments.js-er bhetore chhilo. Ekhon alada file-e rakha hoyeche jate
// duita jaygay theke chalano jay (ar duita-i ekoi logic use kore, drift hoy na):
//   • POST/GET /api/payments?cron=checkDeposits   (puroni URL — cron-job.org-e already set thakle cholbe)
//   • GET      /api/cron/tick                      (notun combined cron — api/ops.js op=tick)
//
// ⚡ CPU / API KOM RAKHAR JONNO PORIBORTON (puroni version-er sathe tulona):
//   1. Pending order na thakle TonCenter API-te KONO call-i jay na (puroni version protibar call korto,
//      order thakuk ba na thakuk — dine 1440 ta faltu external call).
//   2. Pending order-gulo EKBAR-i DB theke ana hoy, tarpor transaction-gulo memory-te match kora hoy
//      (puroni version protita "TC..." tx-er jonno alada findOne korto).
//   3. TonCenter-er tx limit 50 → 30 (1 minute-e 30-er beshi payment asha onek durer kotha).
//   4. TonCenter down thakle admin-ke protibar (protimin) alert jaito — ekhon 30 minute-e max 1 ta.
//
// Double-credit-er kono risk nei: order 'pending' → 'paid' flip ta atomic (status:'pending' gate).

import { tgSend, escHtml } from './telegram.js';
import { TASK_CREATE_REWARD_PER_TASK_WTC } from './constants.js';
import { TON_RECEIVE_ADDRESS, fetchRecentTonTransactions } from './tonPay.js';

const ADMIN_ID = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID);
const TASK_MODERATOR_ID = process.env.TASK_MODERATOR_ID;
// payment sticker price-er koto % hole accept hobe (wallet-side nanoTON rounding-er jonno ektu tolerance)
const MIN_ACCEPT_RATIO = 0.97;
const TX_FETCH_LIMIT = Number(process.env.TON_TX_FETCH_LIMIT) || 30;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const LATE_MATCH_WINDOW_MS = 3 * 60 * 60 * 1000; // how long after expiry a payment made in time can still be matched
const LATE_TX_GRACE_MS = 60 * 1000;               // clock tolerance between chain time and our expiresAt

export async function runTaskCreateCheck(db) {
    const now = new Date();
    const orders = db.collection('taskCreateOrders');

    // 1) expire-hoye-jawa order bondho kora (sosta, indexed)
    const expireResult = await orders.updateMany(
        { status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired', expiredAt: now } }
    );

    // 2) ekhono pending order ache? na thakle TonCenter-e jawar dorkar-i nei
    // FIX: orders that expired in the last LATE_MATCH_WINDOW_MS are still matched, but ONLY if the on-chain
    // payment itself was made before the order's expiresAt. Otherwise a correct payment seen by a late cron run was lost.
    const pending = await orders
        .find(
            { $or: [{ status: 'pending' }, { status: 'expired', expiredAt: { $gte: new Date(now.getTime() - LATE_MATCH_WINDOW_MS) } }] },
            { projection: { memo: 1, amountNanoTon: 1, status: 1, expiresAt: 1 } }
        )
        .limit(500)
        .toArray();
    if (pending.length === 0) {
        return { expired: expireResult.modifiedCount, pending: 0, matched: 0, skippedFetch: true };
    }

    if (!TON_RECEIVE_ADDRESS) throw new Error('TON_RECEIVE_ADDRESS env var not set');

    // 3) ekbar-i on-chain tx ana
    const txs = await fetchRecentTonTransactions(TX_FETCH_LIMIT);
    const byMemo = new Map(pending.map((o) => [o.memo, o]));

    let matched = 0;
    for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg || !inMsg.message) continue;
        const memo = String(inMsg.message).trim();
        const order = byMemo.get(memo);
        if (!order) continue; // amader kono pending order-er memo na
        const receivedNanoTon = Number(inMsg.value || 0);
        if (!receivedNanoTon) continue;
        if (receivedNanoTon < order.amountNanoTon * MIN_ACCEPT_RATIO) continue; // underpaid — expire hoye jabe
        // an already-expired order only counts if the payment was made before it expired
        if (order.status === 'expired') {
            const txMs = Number(tx.utime || 0) * 1000;
            if (!txMs || txMs > new Date(order.expiresAt).getTime() + LATE_TX_GRACE_MS) continue;
        }

        const txHash = tx.transaction_id?.hash || null;

        // ⚠️ ATOMIC claim — ekoi order kokhono duibar paid hobe na
        const claimed = await orders.findOneAndUpdate(
            { _id: order._id, status: order.status }, // 'pending' or (late match) 'expired' — still atomic, can only flip once
            { $set: { status: 'paid', paidAt: now, txHash, receivedNanoTon }, $unset: { expiredAt: '' } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue;
        byMemo.delete(memo);

        // task doc — admin review-er jonno pending_review hishebe
        const taskDoc = {
            title: claimed.draft.title,
            url: claimed.draft.url,
            channelId: claimed.draft.channelId,
            category: 'exclusive',
            verifyType: claimed.draft.verifyType,
            rewardWtc: TASK_CREATE_REWARD_PER_TASK_WTC,
            rewardCurrency: 'wtc',
            rewardUsdt: null,
            limit: claimed.taskCount,
            completionCount: 0,
            isApproved: false,
            reviewStatus: 'pending_review',
            createdAt: now,
            createdBy: claimed.userId,
            isUserCreated: true,
        };
        const insertResult = await db.collection('tasks').insertOne(taskDoc);
        await orders.updateOne({ _id: claimed._id }, { $set: { createdTaskId: insertResult.insertedId } });

        matched++;
        tgSend(claimed.userId,
            `✅ <b>Payment Confirmed!</b>\n\n` +
            `📋 ${escHtml(taskDoc.title)}\n` +
            `👥 ${taskDoc.limit} people will be able to complete it (+${TASK_CREATE_REWARD_PER_TASK_WTC} TXH COIN each)\n\n` +
            `⏳ It's now waiting for admin review — once approved, it'll go live for everyone in the "⭐ Exclusive" tab. 🎉`
        ).catch(() => {});

        const reviewMsg =
            `🆕 <b>New Task Waiting for Review</b>\n\n` +
            `📋 ${escHtml(taskDoc.title)}\n` +
            `🔗 ${escHtml(taskDoc.url)}\n` +
            `👤 Type: ${taskDoc.verifyType === 'api' ? 'Channel/Group Join (API)' : 'Link'}\n` +
            `👥 ${taskDoc.limit} slots · 💰 ${taskDoc.rewardWtc} TXH COIN/person\n\n` +
            `Go to "🕐 Pending Review" in the admin panel to approve/reject.`;
        if (ADMIN_ID) tgSend(ADMIN_ID, reviewMsg).catch(() => {});
        if (TASK_MODERATOR_ID) tgSend(TASK_MODERATOR_ID, reviewMsg).catch(() => {});
    }

    return { expired: expireResult.modifiedCount, pending: pending.length, checked: txs.length, matched };
}

// Error hole admin-ke alert — kintu 30 minute-e max ekbar (cron protimin cholle spam hoye jay).
// Atomic: filter-e `at < cutoff` + upsert → doc already thakle ar cooldown cholle E11000 → chup.
export async function alertAdminThrottled(db, text) {
    if (!ADMIN_ID) return;
    try {
        await db.collection('settings').findOneAndUpdate(
            { _id: 'tonCheckAlert', at: { $lt: new Date(Date.now() - ALERT_COOLDOWN_MS) } },
            { $set: { at: new Date() } },
            { upsert: true }
        );
    } catch (e) {
        if (e?.code === 11000) return; // cooldown cholche
        return;
    }
    await tgSend(ADMIN_ID, text).catch(() => {});
}
