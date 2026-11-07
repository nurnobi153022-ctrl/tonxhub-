// lib/arrowPuzzle.js — Arrow Puzzle backend (games/arrow-puzzle.html), served through api/earn.js
//   { action: 'arrowStatus',  initData }
//   { action: 'arrowStart',   initData, level, token }
//   { action: 'arrowFinish',  initData, id, won, abandoned, ms, mistakes, moves:[arrowId…] }
//   { action: 'arrowGateAd',  initData, gateId, purpose:'reward1'|'reward2', adSession, proof }   (gateId = id of a pending reward)
//
// Everything that matters is decided HERE, from the verified Telegram user (never from the body):
//   • Attempt limit  — max ARROW_MAX_DAILY starts per Bangladesh day (UTC+6), counted at START. Server-controlled daily reset.
//   • Cooldown       — now must be ≥ lastStart + ARROW_COOLDOWN_MS (30 min). lastStart survives midnight.
//   • Level progress — a level unlocks ONLY after the server re-plays the submitted taps
//                      (lib/arrowEngine.js, identical to the game's engine) and they clear the board with 0 mistakes.
//                      The next level is unlocked IMMEDIATELY on that win — nothing has to be collected first.
//   • Coin reward    — credited ONLY by arrowGateAd after the ad proof is verified server-to-server, once per
//                      (pending reward, step) via an idempotency key: ad 1 = +15 (first), ad 2 = +15 (OPTIONAL) → 30 max per level.
//   • Failed run     — pays nothing and costs nothing else: no retry-ad, no gate. The level stays where it was.
//
// A valid win leaves a saved PENDING REWARD. It never blocks anything: the player may collect it right away, later, or
// never skip-lose it — it stays in the document until collected (bounded: GAME_PENDING_MAX newest; an uncollected
// optional 2nd ad expires after GAME_PENDING_BONUS_TTL_MS because ad 1 of it was already paid).
//
// All state of one player is ONE document (collection `arrowPuzzle`, _id = userId), and every transition is a
// single conditional update, so double-taps / parallel requests / replays cannot skip a rule.
//   { _id, day:'YYYY-MM-DD'(BD), used, lastStart, lastToken, unlocked, done:[levels], wins,
//     current:null|{id,token,level,t}, pending:[{id,level,collected:0|1,at,stepAt}] }
//   (legacy field `gate` is migrated into `pending` the first time a document is loaded, then removed)

import crypto from 'crypto';
import { buildLevel, replay } from './arrowEngine.js';
import { recordAdCompletion } from './withdrawRequirements.js';
import { maybeAwardReferralMilestones } from './referral.js';
import { consumeAdsgramS2S } from './adsgramS2S.js';
import {
    ARROW_ADS_REQUIRED, ARROW_MAX_DAILY, ARROW_COOLDOWN_MS, ARROW_LIVES, ARROW_LEVELS,
    ARROW_REWARD_PER_AD, ARROW_REWARD_TOTAL, ARROW_MIN_MS_PER_MOVE, GAME_PENDING_MAX, GAME_PENDING_BONUS_TTL_MS,
} from './constants.js';

const BD_OFFSET_MS = 6 * 3600 * 1000;
const DAY_MS = 86400000;
const bdDay = (now = Date.now()) => new Date(now + BD_OFFSET_MS).toISOString().slice(0, 10);
const nextResetAt = (now = Date.now()) => (Math.floor((now + BD_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BD_OFFSET_MS;
const PURPOSES = new Set(['reward1', 'reward2']);
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

// ── Ad proof verification ──────────────────────────────────────────────────────────────────────────────────
// No rewarded-ad network is connected to Arrow Puzzle yet, so there is NOTHING that can honestly prove an ad was
// watched. Until a verifier is registered here, every ad step is refused and NO coin is ever credited.
// To connect a network later: add  ARROW_AD_VERIFIERS.<name> = async ({ userId, gateId, purpose, adSession, proof }) => boolean
// (it must check `proof` with the network SERVER-TO-SERVER) and set env ARROW_AD_PROVIDER=<name>.
// Adsgram's rewarded ad gives the app a client-side result only (no signed proof) — same trust level as the Mini Bot gate.
// The server still enforces: gate belongs to this user, exact step order, each ad session / proof spendable once, 15 coins per step max.
export const ARROW_AD_VERIFIERS = {
    // S2S: when ADSGRAM_S2S_REQUIRED=1 a confirmation from Adsgram's Reward URL (block=reward) is spent here (lib/adsgramS2S.js).
    adsgram: async ({ userId, gateId }) => !!gateId && await consumeAdsgramS2S(userId, 'reward'),
};
async function verifyAdProof(args) {
    const fn = ARROW_AD_VERIFIERS[process.env.ARROW_AD_PROVIDER || 'adsgram'];
    if (typeof fn !== 'function') return { configured: false, ok: false };
    try { return { configured: true, ok: (await fn(args)) === true }; } catch (e) { return { configured: true, ok: false }; }
}

// ── state helpers ──────────────────────────────────────────────────────────────────────────────────────────
async function loadState(db, userId, keepToken = null) {
    const col = db.collection('arrowPuzzle'), today = bdDay(), now = Date.now();
    try {
        await col.updateOne({ _id: userId }, { $setOnInsert: { day: today, used: 0, lastStart: 0, lastToken: null, unlocked: 1, done: [], current: null, pending: [] } }, { upsert: true });
    } catch (e) { if (e?.code !== 11000) throw e; } // two first requests raced → the other one created it
    await col.updateOne({ _id: userId, day: { $ne: today } }, { $set: { day: today, used: 0 } }); // new BD day → attempts reset (lastStart is kept)
    let s = await col.findOne({ _id: userId });
    // A run that is still 'started' when a request arrives from a fresh page means the player left it: it failed. A failed run
    // pays nothing and blocks nothing (no retry-ad any more) — the level just stays where it was.
    if (s?.current && s.current.token !== keepToken) { // (a retried /start with the SAME token is not an orphan)
        await col.updateOne({ _id: userId, 'current.id': s.current.id }, { $set: { current: null } });
        s = await col.findOne({ _id: userId });
    }
    // Legacy `gate` (old rule: "collect first / watch a retry ad") → a saved pending reward, atomically and only once.
    if (s?.gate) {
        const g = s.gate;
        const upd = { $set: { gate: null } };
        if (g.kind === 'reward' && ARROW_ADS_REQUIRED && g.id) upd.$push = { pending: { $each: [{ id: g.id, level: g.level, collected: g.collected || 0, at: now, stepAt: now }], $slice: -GAME_PENDING_MAX } };
        await col.updateOne({ _id: userId, 'gate.id': g.id }, upd);
        s = await col.findOne({ _id: userId });
    }
    // An uncollected OPTIONAL 2nd ad (ad 1 was already paid) is dropped after a week. Ad-1 rewards are never dropped.
    if ((s?.pending || []).some(p => (p.collected || 0) >= 1 && (p.stepAt || p.at || 0) < now - GAME_PENDING_BONUS_TTL_MS)) {
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
const publicPending = (s) => (s.pending || []).slice(-20).map(p => ({ id: p.id, level: p.level, collected: p.collected || 0 }));
const publicState = (s) => ({
    serverNow: Date.now(), // the game's countdown uses the SERVER clock, not the phone's
    used: s.used, max: ARROW_MAX_DAILY, limit: ARROW_MAX_DAILY,
    cooldownMs: ARROW_COOLDOWN_MS, cooldownUntil: s.lastStart ? s.lastStart + ARROW_COOLDOWN_MS : 0, resetAt: nextResetAt(),
    pending: publicPending(s), gate: null, // `gate` kept (always null) for cached older game pages: nothing ever blocks any more
    perAd: ARROW_REWARD_PER_AD, total: ARROW_REWARD_TOTAL,
    unlocked: s.unlocked, done: s.done || [],
});
function startRefusal(s, level, now) {
    if (s.used >= ARROW_MAX_DAILY) return { reason: 'limit' };
    if (now < s.lastStart + ARROW_COOLDOWN_MS) return { reason: 'cooldown', until: s.lastStart + ARROW_COOLDOWN_MS };
    if (level > s.unlocked) return { reason: 'locked' };
    return null;
}

// ── arrowStatus ──  `secure:true` is what lets the game drop its "Local demo mode" warning: it is only ever sent
// by this code path, after a real, authenticated database read.
export async function handleArrowStatus(req, res, db, userId) {
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });
    const s = await loadState(db, userId);
    return res.status(200).json({ ok: true, secure: true, ...publicState(s) });
}

// ── arrowStart ──
export async function handleArrowStart(req, res, db, userId) {
    const level = Number(req.body?.level), token = req.body?.token;
    if (!Number.isInteger(level) || level < 1 || level > ARROW_LEVELS) return res.status(400).json({ ok: false, error: 'invalid_level' });
    if (!isStr(token, 100)) return res.status(400).json({ ok: false, error: 'invalid_token' });
    const c = await checkUser(db, userId);
    if (!c.ok) return res.status(c.status).json({ ok: false, error: c.error });

    const col = db.collection('arrowPuzzle');
    const s0 = await loadState(db, userId, token);
    if (s0.current?.token === token) return res.status(200).json({ ok: true, id: s0.current.id, used: s0.used }); // same token = same attempt
    if (s0.lastToken === token) return res.status(200).json({ ok: false, reason: 'ended' });                      // that attempt already ended
    const now = Date.now();
    const refuse = startRefusal(s0, level, now);
    if (refuse) return res.status(200).json({ ok: false, ...refuse });

    const id = crypto.randomUUID();
    const upd = await col.findOneAndUpdate(
        { _id: userId, day: bdDay(now), current: null, used: { $lt: ARROW_MAX_DAILY }, lastStart: { $lte: now - ARROW_COOLDOWN_MS }, unlocked: { $gte: level } },
        { $inc: { used: 1 }, $set: { lastStart: now, lastToken: token, current: { id, token, level, t: now } } },
        { returnDocument: 'after' }
    );
    if (!upd) { // a parallel request won the race — report the real reason
        const s1 = await loadState(db, userId, token);
        if (s1.current?.token === token) return res.status(200).json({ ok: true, id: s1.current.id, used: s1.used });
        return res.status(200).json({ ok: false, ...(startRefusal(s1, level, Date.now()) || { reason: 'busy' }) });
    }
    return res.status(200).json({ ok: true, id, used: upd.used, serverNow: now, cooldownUntil: now + ARROW_COOLDOWN_MS });
}

// ── arrowFinish ──
export async function handleArrowFinish(req, res, db, userId) {
    const { id, won, abandoned, moves } = req.body || {};
    if (!isStr(id, 100)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const col = db.collection('arrowPuzzle');
    const s = await col.findOne({ _id: userId });
    if (!s || !s.current || s.current.id !== id) return res.status(200).json({ ok: false }); // only while 'started'
    const level = s.current.level;

    let valid = false;
    if (won === true) {
        const lv = buildLevel(level), n = lv.arrows.length;
        const okMoves = Array.isArray(moves) && moves.length <= n * 2 && moves.every(m => Number.isInteger(m));
        if (okMoves) {
            const v = replay(level, moves); // the server re-plays the taps on the exact board of this level
            const elapsed = Date.now() - s.current.t;
            valid = v.valid && v.cleared && v.mistakes < ARROW_LIVES && elapsed >= n * ARROW_MIN_MS_PER_MOVE;
        }
    }
    // A valid win unlocks the next level RIGHT NOW and leaves a saved pending reward (if ads are on). Nothing has to be
    // collected before playing on. A loss / abandon / invalid win changes no progress and creates no reward and no gate.
    const update = { $set: { current: null, gate: null } };
    if (valid) {
        update.$addToSet = { done: level };
        update.$max = { unlocked: Math.min(ARROW_LEVELS, level + 1) };
        update.$inc = { wins: 1 }; // wins: one per server-replayed valid win (the guard on current.id below makes it once per attempt) — feeds the withdrawal 'same game twice' requirement
        if (ARROW_ADS_REQUIRED) update.$push = { pending: { $each: [{ id, level, collected: 0, at: Date.now(), stepAt: 0 }], $slice: -GAME_PENDING_MAX } };
    }
    const r = await col.updateOne({ _id: userId, 'current.id': id }, update); // atomic: only the first finish for this attempt counts
    if (!r.modifiedCount) return res.status(200).json({ ok: false });
    // referral game milestone: the referred user's server-verified game completions (same counting as lib/withdrawRequirements.js).
    // Only runs on a valid win; the award itself is atomic + once-only in lib/referral.js and never blocks the game.
    if (valid) {
        try {
            const a = await col.findOne({ _id: userId }, { projection: { wins: 1, done: 1 } });
            const plays = Math.max(Math.max(0, Math.floor(Number(a?.wins) || 0)), new Set(a?.done || []).size);
            await maybeAwardReferralMilestones(db, userId, { gameWinsCount: plays });
        } catch (e) { /* never blocks the game result */ }
    }
    return res.status(200).json({ ok: valid, adsOff: !ARROW_ADS_REQUIRED, rewardId: valid && ARROW_ADS_REQUIRED ? id : null });
}

// ── arrowGateAd — one verified ad step of ONE pending reward (gateId = the pending reward's id) ──
export async function handleArrowGateAd(req, res, db, userId, { eligibleFilter }) {
    const { gateId, purpose, adSession, proof } = req.body || {};
    if (!isStr(gateId, 100) || !PURPOSES.has(purpose) || !isStr(adSession, 200) || !isStr(proof, 2000)) return res.status(400).json({ ok: false, error: 'invalid_request' });
    if (!ARROW_ADS_REQUIRED) return res.status(200).json({ ok: false, reason: 'ads_off' });
    const col = db.collection('arrowPuzzle');
    const s = await col.findOne({ _id: userId });
    const p = (s?.pending || []).find(x => x.id === gateId);
    if (!p) return res.status(200).json({ ok: false, reason: 'no_gate' });
    const collected = p.collected || 0;
    if (!(purpose === 'reward1' ? collected === 0 : collected === 1)) return res.status(200).json({ ok: false, reason: 'wrong_step' });

    // 1) real ad proof, verified server-to-server. No verifier connected → refuse, change nothing, credit nothing.
    const v = await verifyAdProof({ userId, gateId, purpose, adSession, proof });
    if (!v.configured) return res.status(200).json({ ok: false, reason: 'ad_not_configured' });
    if (!v.ok) return res.status(200).json({ ok: false, reason: 'ad_unverified' });

    // 2) each ad session and each proof can be spent once, ever
    const proofs = db.collection('arrowAdProofs');
    const sha = crypto.createHash('sha256').update(proof).digest('hex');
    try { await proofs.insertMany([{ _id: 'sess:' + adSession, userId, gateId, purpose, at: new Date() }, { _id: 'proof:' + sha, userId, gateId, purpose, at: new Date() }], { ordered: true }); }
    catch (e) { if (e?.code === 11000 || e?.writeErrors) return res.status(200).json({ ok: false, reason: 'ad_reused' }); throw e; }

    // 3) coins — idempotent: one payout per (pending reward, step), so a level can never pay more than 30
    const key = `arrow:${gateId}:${purpose}`, log = db.collection('arrowRewards');
    let balance = null, paidBefore = false;
    try { await log.insertOne({ _id: key, userId, gateId, purpose, amount: ARROW_REWARD_PER_AD, at: new Date() }); }
    catch (e) { if (e?.code === 11000) paidBefore = true; else throw e; }
    if (!paidBefore) {
        const paid = await db.collection('users').findOneAndUpdate(
            { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
            { $inc: { wtcBalance: ARROW_REWARD_PER_AD, lifetimeWtcEarned: ARROW_REWARD_PER_AD } }, // only ever ADDS to the balance
            { returnDocument: 'after' }
        );
        if (!paid) { await log.deleteOne({ _id: key }); return res.status(200).json({ ok: false, reason: 'not_eligible' }); }
        balance = paid.wtcBalance;
    }

    // 4) advance / close the pending reward (only if it is still exactly the step we verified)
    const done = purpose === 'reward1'
        ? await col.updateOne({ _id: userId, pending: { $elemMatch: { id: gateId, collected: 0 } } }, { $set: { 'pending.$.collected': 1, 'pending.$.stepAt': Date.now() } })
        : await col.updateOne({ _id: userId, pending: { $elemMatch: { id: gateId, collected: 1 } } }, { $pull: { pending: { id: gateId } } });
    if (!done.modifiedCount) return res.status(200).json({ ok: false, reason: 'no_gate' });
    // withdrawal requirement (rolling 24h ads): this ad was verified server-to-server above; one row per (reward, step)
    await recordAdCompletion(db, userId, `arrow:${gateId}:${purpose}`, 'arrowGate');
    const fresh = await col.findOne({ _id: userId });
    return res.status(200).json({ ok: true, collected: purpose === 'reward1' ? 1 : 2, reward: ARROW_REWARD_PER_AD, balance, ...publicState(fresh) });
}
