// lib/gigaDaily.js — Task › Daily › "GigaPub" card (GigaPub rewarded ad, window.showGiga()), served through api/earn.js
//   { action: 'gigaDailyStatus', initData }
//   { action: 'gigaDailyStart',  initData }                                  → signed token, issued right before the ad
//   { action: 'gigaDailyClaim',  initData, startTime, signature, viewMs }    → pays GIGA_DAILY_REWARD
//
// • Reward  — GIGA_DAILY_REWARD TXH COIN per ad (constants.js).
// • Limit   — GIGA_DAILY_LIMIT ads per cycle. The claim that reaches the limit starts a GIGA_DAILY_LOCK_MS (24 h)
//             lock; when it ends the counter starts again from 0 (10 fresh ads).
// • Token   — every ad needs a signed start token (single-use, ≥ GIGA_DAILY_MIN_WATCH_SECONDS old, ≤ 5 min old).
// • Atomic  — the counter move is ONE conditional update, so parallel / replayed requests cannot pass the limit.
//             If the wallet credit is refused afterwards, the counter move is rolled back.
//
// State of one player = ONE document (collection `gigaDaily`, _id = userId):
//   { _id, count, lockedUntil, lastClaim, lastStartUsed, totalClaims }

import crypto from 'crypto';
import {
    GIGA_DAILY_REWARD, GIGA_DAILY_LIMIT, GIGA_DAILY_LOCK_MS, GIGA_DAILY_MIN_GAP_MS, GIGA_DAILY_MIN_WATCH_SECONDS,
} from './constants.js';
import { recordAdCompletion } from './withdrawRequirements.js';

const signGigaDaily = (secret, userId, startTime) =>
    crypto.createHmac('sha256', secret).update(`gigaDaily:${userId}:${startTime}`).digest('hex');

async function ensureDoc(col, userId) {
    try {
        await col.updateOne({ _id: userId }, { $setOnInsert: { count: 0, lockedUntil: 0, lastClaim: 0, lastStartUsed: 0, totalClaims: 0 } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; }
}

// A finished lock starts a fresh cycle (conditional, so it can only ever happen once per lock).
async function releaseIfExpired(col, userId, now) {
    await col.updateOne({ _id: userId, lockedUntil: { $gt: 0, $lte: now } }, { $set: { count: 0, lockedUntil: 0 } });
}

const publicState = (s, now) => {
    const locked = (s.lockedUntil || 0) > now;
    return {
        reward: GIGA_DAILY_REWARD,
        limit: GIGA_DAILY_LIMIT,
        count: Math.min(GIGA_DAILY_LIMIT, s.count || 0),
        left: locked ? 0 : Math.max(0, GIGA_DAILY_LIMIT - (s.count || 0)),
        locked,
        lockedUntil: locked ? s.lockedUntil : 0,
    };
};

async function checkUser(db, userId) {
    const u = await db.collection('users').findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!u) return { error: 'user_not_found', status: 404 };
    if (u.isBanned) return { error: 'banned', status: 403 };
    return { ok: true };
}

export async function handleGigaDailyStatus(req, res, db, userId) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const col = db.collection('gigaDaily'), now = Date.now();
    await ensureDoc(col, userId);
    await releaseIfExpired(col, userId, now);
    const s = await col.findOne({ _id: userId });
    return res.status(200).json({ ok: true, ...publicState(s, now) });
}

export async function handleGigaDailyStart(req, res, db, userId, { secret }) {
    if (!secret) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const col = db.collection('gigaDaily'), now = Date.now();
    await ensureDoc(col, userId);
    await releaseIfExpired(col, userId, now);
    const s = await col.findOne({ _id: userId });
    const st = publicState(s, now);
    if (st.locked || (s.count || 0) >= GIGA_DAILY_LIMIT) return res.status(200).json({ ok: false, reason: 'limit', ...st });
    return res.status(200).json({ ok: true, startTime: now, signature: signGigaDaily(secret, userId, now) });
}

export async function handleGigaDailyClaim(req, res, db, userId, { eligibleFilter, secret }) {
    if (!secret) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const { startTime, signature, viewMs } = req.body || {};
    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    if (signGigaDaily(secret, userId, startTime) !== signature) return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    const startMs = Number(startTime);
    const elapsed = (Date.now() - startMs) / 1000;
    if (!Number.isFinite(elapsed) || elapsed < 0) return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    if (elapsed < GIGA_DAILY_MIN_WATCH_SECONDS) return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    if (elapsed > 300) return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    const viewSec = Number(viewMs) / 1000;
    if (!Number.isFinite(viewSec) || viewSec < 0) return res.status(400).json({ ok: false, error: 'missing_view_time' });
    if (viewSec < GIGA_DAILY_MIN_WATCH_SECONDS) return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    if (viewSec > elapsed + 1.5) return res.status(400).json({ ok: false, error: 'invalid_view_time' });

    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });

    const col = db.collection('gigaDaily'), users = db.collection('users'), now = Date.now();
    await ensureDoc(col, userId);
    await releaseIfExpired(col, userId, now);

    // 1) move the counter — only if: not locked, below the limit, previous claim old enough, token never used before.
    const before = await col.findOneAndUpdate(
        {
            _id: userId,
            lockedUntil: { $lte: now },
            count: { $lt: GIGA_DAILY_LIMIT },
            lastClaim: { $lte: now - GIGA_DAILY_MIN_GAP_MS },
            lastStartUsed: { $lt: startMs },
        },
        [{
            $set: {
                count: { $add: ['$count', 1] },
                totalClaims: { $add: [{ $ifNull: ['$totalClaims', 0] }, 1] },
                lastClaim: now,
                lastStartUsed: startMs,
                lockedUntil: {
                    $cond: [{ $gte: [{ $add: ['$count', 1] }, GIGA_DAILY_LIMIT] }, now + GIGA_DAILY_LOCK_MS, 0],
                },
            },
        }],
        { returnDocument: 'before' }
    );

    if (!before) {
        const s = await col.findOne({ _id: userId });
        const st = publicState(s, now);
        if (st.locked || (s.count || 0) >= GIGA_DAILY_LIMIT) return res.status(200).json({ ok: false, reason: 'limit', ...st });
        if ((s.lastStartUsed || 0) >= startMs) return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        return res.status(200).json({ ok: false, reason: 'too_fast', ...st });
    }

    // 2) pay. If the wallet refuses (flagged account), undo the counter move so nothing is lost.
    const paid = await users.findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
        { $inc: { wtcBalance: GIGA_DAILY_REWARD, lifetimeWtcEarned: GIGA_DAILY_REWARD } },
        { returnDocument: 'after' }
    );
    if (!paid) {
        await col.updateOne({ _id: userId }, {
            $set: { count: before.count || 0, lockedUntil: before.lockedUntil || 0, lastClaim: before.lastClaim || 0, lastStartUsed: before.lastStartUsed || 0, totalClaims: before.totalClaims || 0 },
        });
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    await recordAdCompletion(db, userId, `gigaDaily:${startMs}`, 'gigaDaily'); // counts for the rolling-24h withdrawal requirement
    try {
        await db.collection('gigaDailyLogs').insertOne({ userId: String(userId), reward: GIGA_DAILY_REWARD, n: (before.count || 0) + 1, createdAt: new Date() });
    } catch (e) { /* history is best-effort */ }

    const s = await col.findOne({ _id: userId });
    return res.status(200).json({ ok: true, claimed: GIGA_DAILY_REWARD, balance: paid.wtcBalance, ...publicState(s, Date.now()) });
}
