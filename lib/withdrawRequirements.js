// lib/withdrawRequirements.js — the three withdrawal eligibility requirements.
// ONE function, used by BOTH api/withdraw.js?action=status (to display) and the POST submit (to enforce),
// so what the user sees can never disagree with what the server accepts.
//
// Data sources (all pre-existing, nothing duplicated):
//   Ads   → collection `adCompletions`: one row per server-verified ad claim (written by api/earn.js
//           handleClaimAdReward and lib/arrowPuzzle.js handleArrowGateAd, after their own verification).
//           Counted over a rolling window: createdAt >= now - 24h. _id is unique per ad token → no double count.
//   Tasks → users.completedTasks (a $addToSet array written only by handleTaskComplete) → distinct by construction.
//           Once the target is reached, users.withdrawTasksReqMet is stamped so it stays completed permanently.
//   Games → Spin Wheel: users.lifetimeSpins (bumped once per server-validated spin).
//           Arrow Puzzle: arrowPuzzle.wins (bumped once per server-replayed, valid win; falls back to the
//           number of cleared levels for players who won before this counter existed).
//           1st withdrawal: met when EITHER game alone reaches the target (lifetime plays) — plays are never added together.
//           2nd, 3rd, 4th … withdrawal (EVERY subsequent one): counted again from zero for each withdrawal — only plays made since the
//           previous withdrawal was submitted (users.withdrawGamesBase = the lifetime totals at that moment) — and, with
//           WITHDRAW_REPEAT_REQUIRES_BOTH_GAMES, BOTH Spin Wheel 4/4 AND Arrow Puzzle 4/4 are needed.

import {
    WITHDRAW_REQ_ADS_COUNT, WITHDRAW_REQ_ADS_WINDOW_HOURS,
    WITHDRAW_REQ_TASKS_COUNT, WITHDRAW_REQ_GAME_PLAYS, WITHDRAW_REPEAT_REQUIRES_BOTH_GAMES,
} from './constants.js';

const WINDOW_MS = WITHDRAW_REQ_ADS_WINDOW_HOURS * 60 * 60 * 1000;

export async function getWithdrawRequirements(db, user, { now = Date.now() } = {}) {
    const userId = String(user._id);

    // 1 ── Ads: rolling window
    const since = new Date(now - WINDOW_MS);
    const adsDone = WITHDRAW_REQ_ADS_COUNT > 0 ? await db.collection('adCompletions').countDocuments({ userId, createdAt: { $gte: since } }) : 0;
    const adsCount = Math.min(adsDone, WITHDRAW_REQ_ADS_COUNT);

    // 2 ── Tasks: distinct completions, permanent once met
    const tasksDone = new Set((user.completedTasks || []).map(String)).size;
    const tasksPermanent = user.withdrawTasksReqMet === true;
    const tasksMet = tasksPermanent || tasksDone >= WITHDRAW_REQ_TASKS_COUNT;
    const tasksCount = tasksMet ? WITHDRAW_REQ_TASKS_COUNT : tasksDone;

    // 3 ── Games: best single game
    const spinPlays = Math.max(0, Math.floor(Number(user.lifetimeSpins) || 0));
    const arrowDoc = await db.collection('arrowPuzzle').findOne({ _id: userId }, { projection: { wins: 1, done: 1 } });
    const arrowPlays = Math.max(
        Math.max(0, Math.floor(Number(arrowDoc?.wins) || 0)),
        new Set(arrowDoc?.done || []).size,
    );
    const T = WITHDRAW_REQ_GAME_PLAYS;
    const repeat = (user.withdrawalCount || 0) >= 1;      // 2nd withdrawal onward
    const totals = { spin: spinPlays, arrow: arrowPlays }; // lifetime totals right now
    // plays that count towards THIS withdrawal. 1st withdrawal: lifetime. Later ones: since the previous withdrawal. A user who
    // already withdrew before this rule existed has no baseline yet → it is created at the current totals (baselineMissing),
    // so they start this requirement from 0/4 instead of being credited with all their old plays.
    const base = repeat ? (user.withdrawGamesBase || null) : null;
    const baselineMissing = repeat && !base;
    const spinNow  = repeat ? Math.max(0, spinPlays  - (base ? Number(base.spin)  || 0 : spinPlays))  : spinPlays;
    const arrowNow = repeat ? Math.max(0, arrowPlays - (base ? Number(base.arrow) || 0 : arrowPlays)) : arrowPlays;
    const both = repeat && WITHDRAW_REPEAT_REQUIRES_BOTH_GAMES;
    const gamesMet = both ? (spinNow >= T && arrowNow >= T) : Math.max(spinNow, arrowNow) >= T;
    const bestPlays = both ? Math.min(spinNow, arrowNow) : Math.max(spinNow, arrowNow);

    const ads   = { required: WITHDRAW_REQ_ADS_COUNT,   current: adsCount,   met: adsDone >= WITHDRAW_REQ_ADS_COUNT, windowHours: WITHDRAW_REQ_ADS_WINDOW_HOURS };
    const tasks = { required: WITHDRAW_REQ_TASKS_COUNT, current: tasksCount, met: tasksMet, permanent: tasksMet };
    const games = {
        required: T,
        current: Math.min(bestPlays, T),
        met: gamesMet,
        spin: Math.min(spinNow, T),
        arrow: Math.min(arrowNow, T),
        mode: both ? 'both' : 'either',     // 'both' = Spin 4/4 AND Arrow 4/4 (2nd+ withdrawal) · 'either' = same game 4 times
        repeat,                              // true from the 2nd withdrawal onward (progress counts since the last withdrawal)
        spinMet: spinNow >= T, arrowMet: arrowNow >= T,
    };
    const missing = [];
    if (!ads.met) missing.push('ads');
    if (!tasks.met) missing.push('tasks');
    if (!games.met) missing.push('games');
    return { ads, tasks, games, allMet: missing.length === 0, missing, gamesTotals: totals, baselineMissing };
}

// Stamps the one-time task requirement as permanently completed. Idempotent; never throws.
export async function stampTasksRequirement(users, userId) {
    try { await users.updateOne({ _id: userId, withdrawTasksReqMet: { $ne: true } }, { $set: { withdrawTasksReqMet: true } }); } catch (e) { /* best-effort */ }
}

// Creates the per-withdrawal game baseline for a user who already withdrew before it existed (progress then starts at 0/4).
// Conditional on the field being absent → idempotent and race-safe. Never throws.
export async function stampGamesBaseline(users, userId, totals) {
    try { await users.updateOne({ _id: userId, withdrawGamesBase: { $exists: false } }, { $set: { withdrawGamesBase: { spin: totals.spin, arrow: totals.arrow, at: new Date() } } }); } catch (e) { /* best-effort */ }
}

// Records ONE server-verified ad completion for the rolling-24h requirement. `key` must be unique per
// verified ad (a duplicate insert is ignored, so retries / replays cannot inflate the count). Never throws.
export async function recordAdCompletion(db, userId, key, source) {
    try {
        await db.collection('adCompletions').insertOne({ _id: `${userId}:${key}`, userId: String(userId), source, createdAt: new Date() });
    } catch (e) { if (e?.code !== 11000) console.error('adCompletions insert failed:', e?.message); }
}
