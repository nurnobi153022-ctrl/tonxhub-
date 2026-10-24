// lib/miniBot.js — Mini Bot backend (games/mini-bot.html), served through api/earn.js. SAME RULES AS ARROW PUZZLE:
//   { action: 'miniBotStatus',  initData }
//   { action: 'miniBotStart',   initData }
//   { action: 'miniBotGateAd',  initData, gateId, purpose:'reward1'|'reward2', adSession, proof }
//
//   • Attempts   — max MINI_BOT_DAILY_RUNS_MAX games per Bangladesh day (UTC+6), counted when a game STARTS.
//   • Cooldown   — a game can start only ≥ MINI_BOT_COOLDOWN_MS (1 h) after the START of the previous one.
//   • Reward     — every game pays MINI_BOT_REWARD_TOTAL (30) TXH COIN, credited ONLY by miniBotGateAd, 15 per verified
//                  ad, once per (game, step) through an idempotency key. The game itself never pays anything.
//   • Gate       — starting a game opens ONE gate (2 ads). While it is open, miniBotStart is refused: both ads must be
//                  watched (= the reward collected) before the next game.
//   The gate / limits are enforced only while an ad provider is connected (adsOn). Otherwise: free play, nothing paid.
//
// All state of one player is ONE document (collection `miniBot`, _id = userId); every transition is a single
// conditional update, so double taps / parallel requests / replays cannot skip a rule.
//   { _id, day:'YYYY-MM-DD'(BD), used, lastStart, gate:null|{id, collected, startedAt, stepAt} }

import crypto from 'crypto';
import { recordAdCompletion } from './withdrawRequirements.js';
import {
    MINI_BOT_ADS_REQUIRED, MINI_BOT_DAILY_RUNS_MAX, MINI_BOT_COOLDOWN_MS,
    MINI_BOT_REWARD_PER_AD, MINI_BOT_REWARD_TOTAL, MINI_BOT_MIN_PLAY_MS, MINI_BOT_AD_MIN_MS,
} from './constants.js';

const BD_OFFSET_MS = 6 * 3600 * 1000;
const DAY_MS = 86400000;
const bdDay = (now = Date.now()) => new Date(now + BD_OFFSET_MS).toISOString().slice(0, 10);
const nextResetAt = (now = Date.now()) => (Math.floor((now + BD_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BD_OFFSET_MS;
const PURPOSES = new Set(['reward1', 'reward2']);
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

// ── Ad proof verification ───────────────────────────────────────────────────────────────────────────────────
// Picked with env MINI_BOT_AD_PROVIDER. No provider → the gate is off (free play, nothing paid, nothing blocked).
// ⚠️ 'adsgram': Adsgram's rewarded ad hands the app a client-side result only (no signed proof), so the server can
// enforce only what it can know: the gate belongs to this user, the game was played ≥ MINI_BOT_MIN_PLAY_MS, the two
// steps are ≥ MINI_BOT_AD_MIN_MS apart, and every ad session / proof can be spent once. For cryptographic proof,
// replace this with a check against Adsgram's server-to-server reward callback.
export const MINI_BOT_AD_VERIFIERS = {
    adsgram: async ({ gate }) => !!gate,
};
const adsOn = () => MINI_BOT_ADS_REQUIRED && typeof MINI_BOT_AD_VERIFIERS[process.env.MINI_BOT_AD_PROVIDER || ''] === 'function';
async function verifyAdProof(args) {
    const fn = MINI_BOT_AD_VERIFIERS[process.env.MINI_BOT_AD_PROVIDER || ''];
    if (typeof fn !== 'function') return { configured: false, ok: false };
    try { return { configured: true, ok: (await fn(args)) === true }; } catch (e) { return { configured: true, ok: false }; }
}

// ── state helpers ───────────────────────────────────────────────────────────────────────────────────────────
async function loadState(db, userId) {
    const col = db.collection('miniBot'), today = bdDay();
    try {
        await col.updateOne({ _id: userId }, { $setOnInsert: { day: today, used: 0, lastStart: 0, gate: null } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; } // two first requests raced → the other one created it
    await col.updateOne({ _id: userId, day: { $ne: today } }, { $set: { day: today, used: 0 } }); // new BD day → attempts reset (lastStart is kept)
    return col.findOne({ _id: userId });
}
async function checkUser(db, userId) {
    const u = await db.collection('users').findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!u) return { error: 'user_not_found', status: 404 };
    if (u.isBanned) return { error: 'banned', status: 403 };
    return { ok: true };
}
const publicGate = (g) => (g ? { id: g.id, collected: g.collected || 0, perAd: MINI_BOT_REWARD_PER_AD, total: MINI_BOT_REWARD_TOTAL } : null);
function publicState(s) {
    const on = adsOn(), used = on ? s.used : 0;
    return {
        adsOn: on, used, max: MINI_BOT_DAILY_RUNS_MAX,
        runsToday: used, runsMax: MINI_BOT_DAILY_RUNS_MAX, runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - used), // (names the Earn card already uses)
        cooldownUntil: on && s.lastStart ? s.lastStart + MINI_BOT_COOLDOWN_MS : 0, resetAt: nextResetAt(),
        gate: on ? publicGate(s.gate) : null, perAd: MINI_BOT_REWARD_PER_AD, total: MINI_BOT_REWARD_TOTAL,
    };
}
function startRefusal(s, now) {
    if (s.gate) return { reason: 'gate' };
    if (s.used >= MINI_BOT_DAILY_RUNS_MAX) return { reason: 'limit' };
    if (now < s.lastStart + MINI_BOT_COOLDOWN_MS) return { reason: 'cooldown', until: s.lastStart + MINI_BOT_COOLDOWN_MS };
    return null;
}

// ── miniBotStatus ──
export async function handleMiniBotStatus(req, res, db, userId) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const s = await loadState(db, userId);
    return res.status(200).json({ ok: true, secure: true, ...publicState(s) });
}

// ── miniBotStart — the game may only begin when this answers ok:true ──
export async function handleMiniBotStart(req, res, db, userId) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const col = db.collection('miniBot');
    const s0 = await loadState(db, userId);
    if (!adsOn()) return res.status(200).json({ ok: true, free: true, ...publicState(s0) }); // no ad provider → free play, nothing is counted or paid
    const now = Date.now();
    const refuse = startRefusal(s0, now);
    if (refuse) return res.status(200).json({ ok: false, ...refuse, ...publicState(s0) });

    const id = crypto.randomUUID();
    const upd = await col.findOneAndUpdate(
        { _id: userId, day: bdDay(now), gate: null, used: { $lt: MINI_BOT_DAILY_RUNS_MAX }, lastStart: { $lte: now - MINI_BOT_COOLDOWN_MS } },
        { $inc: { used: 1 }, $set: { lastStart: now, gate: { id, collected: 0, startedAt: now, stepAt: 0 } } },
        { returnDocument: 'after' }
    );
    if (!upd) { // a parallel request won the race — report the real reason
        const s1 = await loadState(db, userId);
        return res.status(200).json({ ok: false, ...(startRefusal(s1, Date.now()) || { reason: 'gate' }), ...publicState(s1) });
    }
    return res.status(200).json({ ok: true, id, ...publicState(upd) });
}

// ── miniBotGateAd — one verified ad step of the open gate ──
export async function handleMiniBotGateAd(req, res, db, userId, { eligibleFilter }) {
    if (!adsOn()) return res.status(200).json({ ok: false, reason: 'ads_off' });
    const { gateId, purpose, adSession, proof } = req.body || {};
    if (!isStr(gateId, 100) || !PURPOSES.has(purpose) || !isStr(adSession, 200) || !isStr(proof, 2000)) return res.status(400).json({ ok: false, error: 'invalid_request' });
    const col = db.collection('miniBot');
    const d = await col.findOne({ _id: userId });
    const g = d?.gate;
    if (!g || g.id !== gateId) return res.status(200).json({ ok: false, reason: 'no_gate' });
    const collected = g.collected || 0, now = Date.now();
    if (!(purpose === 'reward1' ? collected === 0 : collected === 1)) return res.status(200).json({ ok: false, reason: 'wrong_step' });
    if (purpose === 'reward1' && now - (g.startedAt || 0) < MINI_BOT_MIN_PLAY_MS) return res.status(200).json({ ok: false, reason: 'too_early', waitMs: MINI_BOT_MIN_PLAY_MS - (now - g.startedAt) });
    if (purpose === 'reward2' && now - (g.stepAt || 0) < MINI_BOT_AD_MIN_MS) return res.status(200).json({ ok: false, reason: 'too_early', waitMs: MINI_BOT_AD_MIN_MS - (now - g.stepAt) });

    // 1) ad proof
    const v = await verifyAdProof({ userId, gate: g, gateId, purpose, adSession, proof });
    if (!v.configured) return res.status(200).json({ ok: false, reason: 'ad_not_configured' });
    if (!v.ok) return res.status(200).json({ ok: false, reason: 'ad_unverified' });

    // 2) every ad session and every proof can be spent once, ever
    const proofs = db.collection('miniBotAdProofs');
    const sha = crypto.createHash('sha256').update(proof).digest('hex');
    try { await proofs.insertMany([{ _id: 'sess:' + adSession, userId, gateId, purpose, at: new Date() }, { _id: 'proof:' + sha, userId, gateId, purpose, at: new Date() }], { ordered: true }); }
    catch (e) { if (e?.code === 11000 || e?.writeErrors) return res.status(200).json({ ok: false, reason: 'ad_reused' }); throw e; }

    // 3) coins — one payout per (game, step), so a game can never pay more than MINI_BOT_REWARD_TOTAL
    const key = `minibot:${gateId}:${purpose}`, log = db.collection('miniBotRewards');
    let balance = null, paidBefore = false;
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

    // 4) advance / close the gate (only if it is still exactly the step we verified)
    const done = purpose === 'reward1'
        ? await col.updateOne({ _id: userId, 'gate.id': gateId, 'gate.collected': 0 }, { $set: { 'gate.collected': 1, 'gate.stepAt': now } })
        : await col.updateOne({ _id: userId, 'gate.id': gateId, 'gate.collected': 1 }, { $set: { gate: null } });
    if (!done.modifiedCount) return res.status(200).json({ ok: false, reason: 'no_gate' });
    await recordAdCompletion(db, userId, key, 'miniBotGate'); // counts for the rolling-24h withdrawal requirement (best-effort)
    const s = await loadState(db, userId);
    return res.status(200).json({ ok: true, reward: MINI_BOT_REWARD_PER_AD, balance, ...publicState(s) });
}
