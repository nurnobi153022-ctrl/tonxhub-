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
//           Requirement is met when EITHER game alone reaches the target — plays are never added together.

import {
    WITHDRAW_REQ_ADS_COUNT, WITHDRAW_REQ_ADS_WINDOW_HOURS,
    WITHDRAW_REQ_TASKS_COUNT, WITHDRAW_REQ_GAME_PLAYS,
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
    const bestPlays = Math.max(spinPlays, arrowPlays);
    const gamesMet = bestPlays >= WITHDRAW_REQ_GAME_PLAYS;

    const ads   = { required: WITHDRAW_REQ_ADS_COUNT,   current: adsCount,   met: adsDone >= WITHDRAW_REQ_ADS_COUNT, windowHours: WITHDRAW_REQ_ADS_WINDOW_HOURS };
    const tasks = { required: WITHDRAW_REQ_TASKS_COUNT, current: tasksCount, met: tasksMet, permanent: tasksMet };
    const games = {
        required: WITHDRAW_REQ_GAME_PLAYS,
        current: Math.min(bestPlays, WITHDRAW_REQ_GAME_PLAYS),
        met: gamesMet,
        spin: Math.min(spinPlays, WITHDRAW_REQ_GAME_PLAYS),
        arrow: Math.min(arrowPlays, WITHDRAW_REQ_GAME_PLAYS),
    };
    const missing = [];
    if (!ads.met) missing.push('ads');
    if (!tasks.met) missing.push('tasks');
    if (!games.met) missing.push('games');
    return { ads, tasks, games, allMet: missing.length === 0, missing };
}

// Stamps the one-time task requirement as permanently completed. Idempotent; never throws.
export async function stampTasksRequirement(users, userId) {
    try { await users.updateOne({ _id: userId, withdrawTasksReqMet: { $ne: true } }, { $set: { withdrawTasksReqMet: true } }); } catch (e) { /* best-effort */ }
}

// Records ONE server-verified ad completion for the rolling-24h requirement. `key` must be unique per
// verified ad (a duplicate insert is ignored, so retries / replays cannot inflate the count). Never throws.
export async function recordAdCompletion(db, userId, key, source) {
    try {
        await db.collection('adCompletions').insertOne({ _id: `${userId}:${key}`, userId: String(userId), source, createdAt: new Date() });
    } catch (e) { if (e?.code !== 11000) console.error('adCompletions insert failed:', e?.message); }
}
