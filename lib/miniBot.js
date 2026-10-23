// lib/miniBot.js — Earn › TON X HUB Mini Bot (games/mini-bot.html)
//
// The game runs entirely on the player's phone, so the server can never *see* the gameplay.
// What it can do (and does here) is make cheating pointless:
//   • miniBotStart  → issues a signed, single-use run token (HMAC, same pattern as spinStart).
//   • miniBotClaim  → re-validates the reported result, then credits in ONE atomic update that also
//                     (a) burns the token, (b) enforces the daily-run cap, (c) applies REWARD_ELIGIBLE_FILTER.
// Hard ceilings: 30 enemy coins + 170 boss coins per run, the boss part only if the boss was reported
// killed AND enough real time passed, and at most MINI_BOT_DAILY_RUNS_MAX paid runs per BD day.
// A forged request can therefore win at most the ceiling, and only after real elapsed time.

import crypto from 'crypto';
import { ensureDailyReset } from './dailyReset.js';
import { recordAdCompletion } from './withdrawRequirements.js';
import {
    MINI_BOT_ENEMY_COIN_CAP, MINI_BOT_BOSS_COIN, MINI_BOT_DAILY_RUNS_MAX,
    MINI_BOT_MIN_SECONDS_PER_COIN, MINI_BOT_BOSS_MIN_SECONDS, MINI_BOT_TOKEN_MAX_SECONDS,
    MINI_BOT_ADS_REQUIRED, MINI_BOT_REWARD_PER_AD, MINI_BOT_REWARD_TOTAL, MINI_BOT_AD_MIN_MS,
} from './constants.js';

// ── 🎬 Ad gate (same model as lib/arrowPuzzle.js) ───────────────────────────────────────────────────────────
// When MINI_BOT_ADS_REQUIRED is true, every finished run opens ONE gate for the player (collection `miniBotGate`,
// _id = userId):  boss killed → { kind:'reward' }: watch 2 ads, +MINI_BOT_REWARD_PER_AD TXH COIN each;
//                 otherwise   → { kind:'retry'  }: watch 1 ad to unlock the next run (no coins).
// While a gate is open, miniBotStart is refused. With MINI_BOT_ADS_REQUIRED=false nothing here ever blocks or pays.
const PURPOSES = new Set(['reward1', 'reward2', 'retry']);
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

// Registered ad-proof verifiers, picked with env MINI_BOT_AD_PROVIDER. No provider → every ad step is refused.
// ⚠️ 'adsgram': Adsgram's rewarded ad gives the app a client-side result only (no signed proof), so this verifier can
// only enforce what the server can know: the gate was really opened for this user, at least MINI_BOT_AD_MIN_MS passed
// since, and the ad session / proof can be spent once. For cryptographic proof, replace it with a check against
// Adsgram's server-to-server reward callback.
export const MINI_BOT_AD_VERIFIERS = {
    adsgram: async ({ gate }) => !!gate && Date.now() - (gate.openedAt || 0) >= MINI_BOT_AD_MIN_MS,
};
async function verifyAdProof(args) {
    const fn = MINI_BOT_AD_VERIFIERS[process.env.MINI_BOT_AD_PROVIDER || ''];
    if (typeof fn !== 'function') return { configured: false, ok: false };
    try { return { configured: true, ok: (await fn(args)) === true }; } catch (e) { return { configured: true, ok: false }; }
}
const publicGate = (g) => (g ? { id: g.id, kind: g.kind, collected: g.collected || 0, perAd: MINI_BOT_REWARD_PER_AD, total: MINI_BOT_REWARD_TOTAL } : null);
async function loadGate(db, userId) {
    if (!MINI_BOT_ADS_REQUIRED) return null;
    const d = await db.collection('miniBotGate').findOne({ _id: userId }, { projection: { gate: 1 } });
    return d?.gate || null;
}
async function openGate(db, userId, id, kind) {
    if (!MINI_BOT_ADS_REQUIRED) return null;
    const gate = { id: String(id), kind, collected: 0, openedAt: Date.now() };
    try {
        await db.collection('miniBotGate').updateOne({ _id: userId, $or: [{ gate: null }, { gate: { $exists: false } }] }, { $set: { gate } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; } // a gate is already open → keep it
    return publicGate(await loadGate(db, userId));
}

// Pure: turns the client's report into the amount that may be paid (or an error code).
export function validateRun({ coins, bossKilled }, elapsedSeconds) {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return { error: 'invalid_run_token' };
    if (elapsedSeconds > MINI_BOT_TOKEN_MAX_SECONDS) return { error: 'run_token_expired' };
    const c = Math.floor(Number(coins));
    if (!Number.isFinite(c) || c < 0) return { error: 'invalid_result' };
    const killed = bossKilled === true;
    // enemy part: capped, and needs real play time
    let enemy = Math.min(c, MINI_BOT_ENEMY_COIN_CAP + (killed ? MINI_BOT_BOSS_COIN : 0));
    let boss = 0;
    if (killed) {
        // anything above the enemy cap can only be the boss reward
        enemy = Math.min(c, MINI_BOT_ENEMY_COIN_CAP);
        if (elapsedSeconds < MINI_BOT_BOSS_MIN_SECONDS) return { error: 'run_too_short' };
        boss = MINI_BOT_BOSS_COIN;
    } else {
        enemy = Math.min(c, MINI_BOT_ENEMY_COIN_CAP);
    }
    if (enemy * MINI_BOT_MIN_SECONDS_PER_COIN > elapsedSeconds) return { error: 'run_too_short' };
    return { reward: enemy + boss, enemy, boss };
}

export async function handleMiniBotStatus(req, res, db, userId) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const u = await users.findOne({ _id: userId }, { projection: { miniBotRunsToday: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const used = u.miniBotRunsToday || 0;
    return res.status(200).json({ ok: true, runsToday: used, runsMax: MINI_BOT_DAILY_RUNS_MAX, runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - used), maxReward: MINI_BOT_ENEMY_COIN_CAP + MINI_BOT_BOSS_COIN,
        adsRequired: MINI_BOT_ADS_REQUIRED, gate: publicGate(await loadGate(db, userId)) });
}

// Issues a run token. Does NOT consume a run (an abandoned game costs nothing) — the cap is enforced at claim.
export async function handleMiniBotStart(req, res, db, userId, { signRun }) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const u = await users.findOne({ _id: userId }, { projection: { miniBotRunsToday: 1, isBanned: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    const used = u.miniBotRunsToday || 0;
    const gate = await loadGate(db, userId);
    if (gate) return res.status(200).json({ ok: false, reason: 'gate', gate: publicGate(gate) }); // finish the reward / retry ad step first
    const startTime = Date.now();
    return res.status(200).json({
        ok: true, startTime, signature: signRun(userId, startTime),
        runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - used), runsMax: MINI_BOT_DAILY_RUNS_MAX,
        adsRequired: MINI_BOT_ADS_REQUIRED,
        paid: used < MINI_BOT_DAILY_RUNS_MAX, // false → the player may still play for fun, but nothing will be paid
    });
}

export async function handleMiniBotClaim(req, res, db, userId, { signRun, eligibleFilter }) {
    const { startTime, signature, coins, bossKilled, score } = req.body || {};
    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_run_token' });
    if (signRun(userId, startTime) !== signature) return res.status(400).json({ ok: false, error: 'invalid_run_token' });

    const v = validateRun({ coins, bossKilled }, (Date.now() - Number(startTime)) / 1000);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    if (v.reward <= 0) { // nothing earned → nothing to record; a failed run still needs its retry ad
        const g0 = await openGate(db, userId, startTime, 'retry');
        return res.status(200).json({ ok: true, reward: 0, gate: g0 });
    }

    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const key = String(startTime); // single-use, same pattern as usedSpinStarts
    const credited = await users.findOneAndUpdate(
        {
            _id: userId, isBanned: { $ne: true }, usedMiniBotStarts: { $ne: key },
            $and: [
                { $or: [{ miniBotRunsToday: { $exists: false } }, { miniBotRunsToday: { $lt: MINI_BOT_DAILY_RUNS_MAX } }] },
                eligibleFilter,
            ],
        },
        {
            $inc: { wtcBalance: v.reward, lifetimeWtcEarned: v.reward, miniBotRunsToday: 1 },
            $addToSet: { usedMiniBotStarts: key },
        },
        { returnDocument: 'after' }
    );

    if (!credited) {
        const u = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, usedMiniBotStarts: 1, miniBotRunsToday: 1 } });
        if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((u.usedMiniBotStarts || []).includes(key)) return res.status(400).json({ ok: false, error: 'run_token_already_used' });
        if ((u.miniBotRunsToday || 0) >= MINI_BOT_DAILY_RUNS_MAX) return res.status(200).json({ ok: true, reward: 0, limitReached: true, runsLeft: 0 }); // unpaid runs never open a gate
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    try {
        await db.collection('miniBotLogs').insertOne({
            userId: String(userId), reward: v.reward, enemy: v.enemy, boss: v.boss, bossKilled: v.boss > 0,
            score: Math.max(0, Math.min(1e9, Math.floor(Number(score) || 0))),
            seconds: Math.round((Date.now() - Number(startTime)) / 1000), createdAt: new Date(),
        });
    } catch (e) { /* history is best-effort — never blocks the reward */ }

    const gate = await openGate(db, userId, startTime, v.boss > 0 ? 'reward' : 'retry');
    return res.status(200).json({
        ok: true, reward: v.reward, enemy: v.enemy, boss: v.boss,
        balance: credited.wtcBalance, runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - (credited.miniBotRunsToday || 0)), gate,
    });
}

// ── miniBotGateAd — one verified ad step of the open gate ──
//   { gateId, purpose:'reward1'|'reward2'|'retry', adSession, proof }
export async function handleMiniBotGateAd(req, res, db, userId, { eligibleFilter }) {
    if (!MINI_BOT_ADS_REQUIRED) return res.status(200).json({ ok: false, reason: 'ads_off' });
    const { gateId, purpose, adSession, proof } = req.body || {};
    if (!isStr(gateId, 100) || !PURPOSES.has(purpose) || !isStr(adSession, 200) || !isStr(proof, 2000)) return res.status(400).json({ ok: false, error: 'invalid_request' });
    const col = db.collection('miniBotGate');
    const d = await col.findOne({ _id: userId });
    const g = d?.gate;
    if (!g || g.id !== gateId) return res.status(200).json({ ok: false, reason: 'no_gate' });
    const collected = g.collected || 0;
    const fits = purpose === 'retry' ? g.kind === 'retry' : g.kind === 'reward' && (purpose === 'reward1' ? collected === 0 : collected === 1);
    if (!fits) return res.status(200).json({ ok: false, reason: 'wrong_step' });

    // 1) ad proof — no provider configured → refuse, change nothing, credit nothing
    const v = await verifyAdProof({ userId, gate: g, gateId, purpose, adSession, proof });
    if (!v.configured) return res.status(200).json({ ok: false, reason: 'ad_not_configured' });
    if (!v.ok) return res.status(200).json({ ok: false, reason: 'ad_unverified' });

    // 2) every ad session and every proof can be spent once, ever
    const proofs = db.collection('miniBotAdProofs');
    const sha = crypto.createHash('sha256').update(proof).digest('hex');
    try { await proofs.insertMany([{ _id: 'sess:' + adSession, userId, gateId, purpose, at: new Date() }, { _id: 'proof:' + sha, userId, gateId, purpose, at: new Date() }], { ordered: true }); }
    catch (e) { if (e?.code === 11000 || e?.writeErrors) return res.status(200).json({ ok: false, reason: 'ad_reused' }); throw e; }

    // 3) coins (reward steps only) — one payout per (gate, step), so a win can never pay more than MINI_BOT_REWARD_TOTAL
    let balance = null;
    if (purpose !== 'retry') {
        const key = `minibot:${gateId}:${purpose}`, log = db.collection('miniBotRewards');
        let paidBefore = false;
        try { await log.insertOne({ _id: key, userId, gateId, purpose, amount: MINI_BOT_REWARD_PER_AD, at: new Date() }); }
        catch (e) { if (e?.code === 11000) paidBefore = true; else throw e; }
        if (!paidBefore) {
            const paid = await db.collection('users').findOneAndUpdate(
                { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
                { $inc: { wtcBalance: MINI_BOT_REWARD_PER_AD, lifetimeWtcEarned: MINI_BOT_REWARD_PER_AD } },
                { returnDocument: 'after' }
            );
            if (!paid) { await log.deleteOne({ _id: key }); return res.status(200).json({ ok: false, reason: 'not_eligible' }); }
            balance = paid.wtcBalance;
        }
    }

    // 4) advance / close the gate (only if it is still exactly the step we verified)
    const done = purpose === 'reward1'
        ? await col.updateOne({ _id: userId, 'gate.id': gateId, 'gate.collected': 0 }, { $set: { 'gate.collected': 1 } })
        : await col.updateOne({ _id: userId, 'gate.id': gateId }, { $set: { gate: null } });
    if (!done.modifiedCount) return res.status(200).json({ ok: false, reason: 'no_gate' });
    await recordAdCompletion(db, userId, `minibot:${gateId}:${purpose}`, 'miniBotGate');
    const after = purpose === 'reward1' ? publicGate({ ...g, collected: 1 }) : null;
    return res.status(200).json({ ok: true, gate: after, collected: purpose === 'reward1' ? 1 : 2, reward: purpose === 'retry' ? 0 : MINI_BOT_REWARD_PER_AD, balance, total: MINI_BOT_REWARD_TOTAL });
}
