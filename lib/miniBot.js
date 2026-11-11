// lib/miniBot.js — Mini Bot backend (games/mini-bot.html), served through api/earn.js. SAME RULES AS ARROW PUZZLE:
//   { action: 'miniBotStatus',  initData }
//   { action: 'miniBotStart',   initData }
//   { action: 'miniBotGateAd',  initData, gateId, purpose:'reward1'|'reward2', adSession, proof }   (gateId = id of a pending reward = the run id)
//
//   • Attempts   — max MINI_BOT_DAILY_RUNS_MAX games per Bangladesh day (UTC+6), counted when a game STARTS. Server-controlled daily reset.
//   • Cooldown   — a game can start only ≥ MINI_BOT_COOLDOWN_MS (30 min) after the START of the previous one. Enforced here, not in the UI.
//   • Reward     — every game pays MINI_BOT_REWARD_TOTAL (30) TXH COIN, credited ONLY by miniBotGateAd and ONLY when BOTH ads are
//                  verified (the 2nd one pays, once per game through an idempotency key). Ad 1 alone pays nothing. The game itself never pays.
//   • Pending    — starting a game saves ONE pending reward {id, collected:0|1}. Watching BOTH ads is MANDATORY: until the reward is
//                  closed no new game can start ('ads_required'). It stays saved until collected, so closing the app never skips it.
//   • Ad view    — every ad step must report ≥ INT_AD_MIN_VIEW_SECONDS (7 s) on screen; shorter = nothing paid, and a view time the
//                  server's own timeline proves impossible flags the user SUSPICIOUS (lib/suspicious.js).
//   The limits / rewards are enforced only while an ad provider is connected (adsOn). Otherwise: free play, nothing paid.
//
// All state of one player is ONE document (collection `miniBot`, _id = userId); every transition is a single
// conditional update, so double taps / parallel requests / replays cannot skip a rule.
//   { _id, day:'YYYY-MM-DD'(BD), used, lastStart, pending:[{id, collected, startedAt, stepAt}] }
//   (legacy field `gate` is migrated into `pending` the first time a document is loaded, then removed)

import crypto from 'crypto';
import { recordAdCompletion } from './withdrawRequirements.js';
import { consumeAdsgramS2S } from './adsgramS2S.js';
import { flagSuspicious, auditRewardView } from './suspicious.js';
import {
    INT_AD_MIN_VIEW_MS, MINI_BOT_ADS_REQUIRED, MINI_BOT_DAILY_RUNS_MAX, MINI_BOT_COOLDOWN_MS,
    MINI_BOT_REWARD_PER_AD, MINI_BOT_REWARD_TOTAL, MINI_BOT_MIN_PLAY_MS, MINI_BOT_AD_MIN_MS, GAME_PENDING_MAX, GAME_PENDING_BONUS_TTL_MS,
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
// enforce only what it can know: the pending reward belongs to this user, the game was played ≥ MINI_BOT_MIN_PLAY_MS, the two
// steps are ≥ MINI_BOT_AD_MIN_MS apart, and every ad session / proof can be spent once. For cryptographic proof,
// replace this with a check against Adsgram's server-to-server reward callback.
export const MINI_BOT_AD_VERIFIERS = {
    // S2S: when ADSGRAM_S2S_REQUIRED=1 a confirmation from Adsgram's Reward URL (block=reward) is spent here (lib/adsgramS2S.js).
    adsgram: async ({ userId, gateId }) => !!gateId && await consumeAdsgramS2S(userId, 'reward'),
};
const adsOn = () => MINI_BOT_ADS_REQUIRED && typeof MINI_BOT_AD_VERIFIERS[process.env.MINI_BOT_AD_PROVIDER || 'adsgram'] === 'function';
async function verifyAdProof(args) {
    const fn = MINI_BOT_AD_VERIFIERS[process.env.MINI_BOT_AD_PROVIDER || 'adsgram'];
    if (typeof fn !== 'function') return { configured: false, ok: false };
    try { return { configured: true, ok: (await fn(args)) === true }; } catch (e) { return { configured: true, ok: false }; }
}

// ── state helpers ───────────────────────────────────────────────────────────────────────────────────────────
async function loadState(db, userId) {
    const col = db.collection('miniBot'), today = bdDay(), now = Date.now();
    try {
        await col.updateOne({ _id: userId }, { $setOnInsert: { day: today, used: 0, lastStart: 0, pending: [] } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; } // two first requests raced → the other one created it
    await col.updateOne({ _id: userId, day: { $ne: today } }, { $set: { day: today, used: 0 } }); // new BD day → attempts reset (lastStart is kept)
    let s = await col.findOne({ _id: userId });
    // Legacy `gate` (old rule: "collect both ads before the next game") → a saved pending reward, atomically and only once.
    if (s?.gate) {
        const g = s.gate;
        await col.updateOne({ _id: userId, 'gate.id': g.id }, {
            $set: { gate: null },
            $push: { pending: { $each: [{ id: g.id, collected: g.collected || 0, startedAt: g.startedAt || 0, stepAt: g.stepAt || now }], $slice: -GAME_PENDING_MAX } },
        });
        s = await col.findOne({ _id: userId });
    }
    // An uncollected OPTIONAL 2nd ad (ad 1 was already paid) is dropped after a week. Ad-1 rewards are never dropped.
    if ((s?.pending || []).some(p => (p.collected || 0) >= 1 && (p.stepAt || 0) < now - GAME_PENDING_BONUS_TTL_MS)) {
        await col.updateOne({ _id: userId }, { $pull: { pending: { collected: { $gte: 1 }, stepAt: { $lt: now - GAME_PENDING_BONUS_TTL_MS } } } });
        s = await col.findOne({ _id: userId });
    }
    return s;
}
async function checkUser(db, userId) {
    const u = await db.collection('users').findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!u) return { error: 'user_not_found', status: 404 };
    if (u.isBanned) return { error: 'banned', status: 403 };
    return { ok: true };
}
const publicPending = (s) => (s.pending || []).slice(-20).map(p => ({ id: p.id, collected: p.collected || 0, perAd: MINI_BOT_REWARD_PER_AD, total: MINI_BOT_REWARD_TOTAL }));
function publicState(s) {
    const on = adsOn(), used = on ? s.used : 0;
    return {
        adsOn: on, serverNow: Date.now(), // the game's countdown uses the SERVER clock, not the phone's
        used, max: MINI_BOT_DAILY_RUNS_MAX,
        runsToday: used, runsMax: MINI_BOT_DAILY_RUNS_MAX, runsLeft: Math.max(0, MINI_BOT_DAILY_RUNS_MAX - used), // (names the Earn card already uses)
        cooldownMs: MINI_BOT_COOLDOWN_MS, cooldownUntil: on && s.lastStart ? s.lastStart + MINI_BOT_COOLDOWN_MS : 0, resetAt: nextResetAt(),
        pending: on ? publicPending(s) : [], gate: null, // `gate` kept (always null); a saved pending reward now blocks the next start itself
        adsRequired: 2, minViewMs: INT_AD_MIN_VIEW_MS, blocked: on && (s.pending || []).length > 0,
        perAd: MINI_BOT_REWARD_PER_AD, total: MINI_BOT_REWARD_TOTAL,
    };
}
function startRefusal(s, now) {
    if ((s.pending || []).length > 0) return { reason: 'ads_required' }; // both reward ads of the last game come first
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
        { _id: userId, day: bdDay(now), 'pending.0': { $exists: false }, used: { $lt: MINI_BOT_DAILY_RUNS_MAX }, lastStart: { $lte: now - MINI_BOT_COOLDOWN_MS } },
        { $inc: { used: 1 }, $set: { lastStart: now, gate: null }, $push: { pending: { $each: [{ id, collected: 0, startedAt: now, stepAt: 0 }], $slice: -GAME_PENDING_MAX } } },
        { returnDocument: 'after' }
    );
    if (!upd) { // a parallel request won the race — report the real reason
        const s1 = await loadState(db, userId);
        return res.status(200).json({ ok: false, ...(startRefusal(s1, Date.now()) || { reason: 'busy' }), ...publicState(s1) });
    }
    return res.status(200).json({ ok: true, id, ...publicState(upd) });
}

// ── miniBotGateAd — one verified ad step of ONE pending reward (gateId = the run id) ──
export async function handleMiniBotGateAd(req, res, db, userId, { eligibleFilter }) {
    if (!adsOn()) return res.status(200).json({ ok: false, reason: 'ads_off' });
    const { gateId, purpose, adSession, proof, viewMs } = req.body || {};
    if (!isStr(gateId, 100) || !PURPOSES.has(purpose) || !isStr(adSession, 200) || !isStr(proof, 2000)) return res.status(400).json({ ok: false, error: 'invalid_request' });
    const col = db.collection('miniBot');
    const d = await col.findOne({ _id: userId });
    const g = (d?.pending || []).find(x => x.id === gateId);
    if (!g) return res.status(200).json({ ok: false, reason: 'no_gate' });
    const collected = g.collected || 0, now = Date.now();
    if (!(purpose === 'reward1' ? collected === 0 : collected === 1)) return res.status(200).json({ ok: false, reason: 'wrong_step' });
    if (purpose === 'reward1' && now - (g.startedAt || 0) < MINI_BOT_MIN_PLAY_MS) return res.status(200).json({ ok: false, reason: 'too_early', waitMs: MINI_BOT_MIN_PLAY_MS - (now - g.startedAt) });
    if (purpose === 'reward2' && now - (g.stepAt || 0) < MINI_BOT_AD_MIN_MS) return res.status(200).json({ ok: false, reason: 'too_early', waitMs: MINI_BOT_AD_MIN_MS - (now - g.stepAt) });

    // 0b) ad view time — ≥ 7 s on screen or nothing is paid and the step does not count
    const view = Number(viewMs);
    if (!Number.isFinite(view) || view < INT_AD_MIN_VIEW_MS) return res.status(200).json({ ok: false, reason: 'watch_time_too_short' });
    // The ad can only have started after this step became available (game start for ad 1, ad-1 time for ad 2) → it cannot have
    // been on screen longer than the server's own elapsed time (plus a little network slack). A longer claim = forged → SUSPICIOUS.
    const refAt = purpose === 'reward1' ? g.startedAt : g.stepAt;
    if (refAt && view > (now - refAt) + 1500) {
        await flagSuspicious(db, userId, { source: 'miniBotGate:' + purpose, reason: 'view_time_exceeds_server_timeline', viewMs: view, extra: { serverElapsedMs: now - refAt } });
        return res.status(200).json({ ok: false, reason: 'invalid_view_time' });
    }

    // 1) ad proof
    const v = await verifyAdProof({ userId, gate: g, gateId, purpose, adSession, proof });
    if (!v.configured) return res.status(200).json({ ok: false, reason: 'ad_not_configured' });
    if (!v.ok) return res.status(200).json({ ok: false, reason: 'ad_unverified' });

    // 2) every ad session and every proof can be spent once, ever
    const proofs = db.collection('miniBotAdProofs');
    const sha = crypto.createHash('sha256').update(proof).digest('hex');
    try { await proofs.insertMany([{ _id: 'sess:' + adSession, userId, gateId, purpose, at: new Date() }, { _id: 'proof:' + sha, userId, gateId, purpose, at: new Date() }], { ordered: true }); }
    catch (e) { if (e?.code === 11000 || e?.writeErrors) return res.status(200).json({ ok: false, reason: 'ad_reused' }); throw e; }

    // 3) coins — ONLY on the 2nd ad, once per game (idempotency key), so a game can never pay more than MINI_BOT_REWARD_TOTAL.
    //    Legacy: a game whose ad 1 already paid coins under the old 15 + 15 rule is topped up with the remainder only.
    const key = `minibot:${gateId}:${purpose}`, log = db.collection('miniBotRewards');
    let balance = null;
    if (purpose === 'reward2') {
        const legacy = await log.findOne({ _id: `minibot:${gateId}:reward1` });
        const amount = Math.max(0, MINI_BOT_REWARD_TOTAL - (legacy?.amount || 0));
        let paidBefore = false;
        try { await log.insertOne({ _id: key, userId, gateId, purpose, amount, at: new Date() }); }
        catch (e) { if (e?.code === 11000) paidBefore = true; else throw e; }
        if (!paidBefore && amount > 0) {
            const paid = await db.collection('users').findOneAndUpdate(
                { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
                { $inc: { wtcBalance: amount, lifetimeWtcEarned: amount } }, // only ever ADDS to the balance
                { returnDocument: 'after' }
            );
            if (!paid) { await log.deleteOne({ _id: key }); return res.status(200).json({ ok: false, reason: 'not_eligible' }); }
            balance = paid.wtcBalance;
        }
    }

    // 4) advance / close the pending reward (only if it is still exactly the step we verified)
    const done = purpose === 'reward1'
        ? await col.updateOne({ _id: userId, pending: { $elemMatch: { id: gateId, collected: 0 } } }, { $set: { 'pending.$.collected': 1, 'pending.$.stepAt': now } })
        : await col.updateOne({ _id: userId, pending: { $elemMatch: { id: gateId, collected: 1 } } }, { $pull: { pending: { id: gateId } } });
    if (!done.modifiedCount) return res.status(200).json({ ok: false, reason: 'no_gate' });
    await recordAdCompletion(db, userId, key, 'miniBotGate'); // counts for the rolling-24h withdrawal requirement (best-effort)
    if (purpose === 'reward2') await auditRewardView(db, userId, { source: 'miniBotGate', viewMs: view }); // backstop (see lib/suspicious.js)
    const s = await col.findOne({ _id: userId });
    return res.status(200).json({ ok: true, collected: purpose === 'reward1' ? 1 : 2, reward: purpose === 'reward2' ? MINI_BOT_REWARD_TOTAL : 0, balance, ...publicState(s) });
}
