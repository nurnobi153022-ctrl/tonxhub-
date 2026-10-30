// lib/adMission.js — Task › Daily › "Ad Missions" box (Adsgram Task ad), served through api/earn.js
//   { action: 'adMissionStatus', initData }
//   { action: 'adMissionClaim',  initData }
//
// The player taps GO on the Adsgram task card; Adsgram fires its `reward` event in the app and the app calls
// adMissionClaim. Everything that matters is decided HERE, from the verified Telegram user:
//   • Reward   — AD_MISSION_REWARD TXH COIN per claim (constants.js).
//   • Limit    — AD_MISSION_DAILY_LIMIT claims per cycle. The claim that reaches the limit starts a
//                AD_MISSION_LOCK_MS (24 h) lock; when it ends the counter starts again from 0.
//   • Anti-script — two claims can never be closer than AD_MISSION_MIN_GAP_MS.
//   • Atomic   — the counter move is ONE conditional update, so parallel / replayed requests cannot
//                pass the limit. If the wallet credit is refused afterwards, the counter move is rolled back.
//
// State of one player = ONE document (collection `adMission`, _id = userId):
//   { _id, count, lockedUntil, lastClaim, totalClaims }

import {
    AD_MISSION_REWARD, AD_MISSION_DAILY_LIMIT, AD_MISSION_LOCK_MS, AD_MISSION_MIN_GAP_MS,
} from './constants.js';
import { recordAdCompletion } from './withdrawRequirements.js';
import { consumeAdsgramS2S } from './adsgramS2S.js';

async function ensureDoc(col, userId) {
    try {
        await col.updateOne({ _id: userId }, { $setOnInsert: { count: 0, lockedUntil: 0, lastClaim: 0, totalClaims: 0 } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; } // two first requests raced → the other one created it
}

// A finished lock starts a fresh cycle (conditional, so it can only ever happen once per lock).
async function releaseIfExpired(col, userId, now) {
    await col.updateOne({ _id: userId, lockedUntil: { $gt: 0, $lte: now } }, { $set: { count: 0, lockedUntil: 0 } });
}

const publicState = (s, now) => {
    const locked = (s.lockedUntil || 0) > now;
    return {
        reward: AD_MISSION_REWARD,
        limit: AD_MISSION_DAILY_LIMIT,
        count: Math.min(AD_MISSION_DAILY_LIMIT, s.count || 0),
        left: locked ? 0 : Math.max(0, AD_MISSION_DAILY_LIMIT - (s.count || 0)),
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

export async function handleAdMissionStatus(req, res, db, userId) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const col = db.collection('adMission'), now = Date.now();
    await ensureDoc(col, userId);
    await releaseIfExpired(col, userId, now);
    const s = await col.findOne({ _id: userId });
    return res.status(200).json({ ok: true, ...publicState(s, now) });
}

export async function handleAdMissionClaim(req, res, db, userId, { eligibleFilter }) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });

    const col = db.collection('adMission'), users = db.collection('users'), now = Date.now();
    await ensureDoc(col, userId);
    await releaseIfExpired(col, userId, now);

    // 1) move the counter — only if: not locked, below the limit, and the previous claim is old enough.
    //    The claim that reaches the limit also sets the lock (aggregation-pipeline update, still ONE atomic write).
    const before = await col.findOneAndUpdate(
        {
            _id: userId,
            lockedUntil: { $lte: now },
            count: { $lt: AD_MISSION_DAILY_LIMIT },
            lastClaim: { $lte: now - AD_MISSION_MIN_GAP_MS },
        },
        [{
            $set: {
                count: { $add: ['$count', 1] },
                totalClaims: { $add: [{ $ifNull: ['$totalClaims', 0] }, 1] },
                lastClaim: now,
                lockedUntil: {
                    $cond: [{ $gte: [{ $add: ['$count', 1] }, AD_MISSION_DAILY_LIMIT] }, now + AD_MISSION_LOCK_MS, 0],
                },
            },
        }],
        { returnDocument: 'before' }
    );

    if (!before) { // refused — report the real reason
        const s = await col.findOne({ _id: userId });
        const st = publicState(s, now);
        if (st.locked || (s.count || 0) >= AD_MISSION_DAILY_LIMIT) return res.status(200).json({ ok: false, reason: 'limit', ...st });
        return res.status(200).json({ ok: false, reason: 'too_fast', ...st });
    }

    // 1b) Adsgram server-to-server confirmation (only enforced when ADSGRAM_S2S_REQUIRED=1, see lib/adsgramS2S.js).
    //     No confirmation from Adsgram's Reward URL → undo the counter move and refuse.
    if (!(await consumeAdsgramS2S(userId, 'task', { db }))) {
        await col.updateOne({ _id: userId }, {
            $set: { count: before.count || 0, lockedUntil: before.lockedUntil || 0, lastClaim: before.lastClaim || 0, totalClaims: before.totalClaims || 0 },
        });
        return res.status(200).json({ ok: false, reason: 's2s_unconfirmed' });
    }

    // 2) pay. If the wallet refuses (flagged account), undo the counter move so nothing is lost.
    const paid = await users.findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
        { $inc: { wtcBalance: AD_MISSION_REWARD, lifetimeWtcEarned: AD_MISSION_REWARD } },
        { returnDocument: 'after' }
    );
    if (!paid) {
        await col.updateOne({ _id: userId }, {
            $set: { count: before.count || 0, lockedUntil: before.lockedUntil || 0, lastClaim: before.lastClaim || 0, totalClaims: before.totalClaims || 0 },
        });
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    const key = `adMission:${now}`;
    await recordAdCompletion(db, userId, key, 'adMission'); // counts for the rolling-24h withdrawal requirement (best-effort, never throws)
    try {
        await db.collection('adMissionLogs').insertOne({ userId: String(userId), reward: AD_MISSION_REWARD, n: (before.count || 0) + 1, createdAt: new Date() });
    } catch (e) { /* history is best-effort — never blocks the reward */ }

    const s = await col.findOne({ _id: userId });
    return res.status(200).json({ ok: true, claimed: AD_MISSION_REWARD, balance: paid.wtcBalance, ...publicState(s, Date.now()) });
}
