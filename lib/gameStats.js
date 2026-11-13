// lib/gameStats.js — per-user "game window" stats for the admin panel (🎮 Game Stats).
//
// What is tracked (Mini Bot + Arrow Puzzle only):
//   plays → how many times the user STARTED a game      coins → TXH COIN actually paid by that game
//
// Window rules (as requested):
//   • Nothing is counted before the user's FIRST withdrawal request.
//   • The first withdrawal request opens the window (counters at 0).
//   • Everything the user plays/earns afterwards is counted, and the admin sees it until the user submits the
//     NEXT (2nd) withdrawal request. That request shows the final numbers in the admin's withdraw message, then
//     the old history is deleted (counters back to 0) and a fresh window starts for the following withdrawal.
//
// Stored on the user doc as `gameStats: { since, miniPlays, miniCoins, arrowPlays, arrowCoins, plays }`.
// Every function is best-effort and never throws — stats must never break a game or a withdrawal.

const FIELD = { mini: ['gameStats.miniPlays', 'gameStats.miniCoins'], arrow: ['gameStats.arrowPlays', 'gameStats.arrowCoins'] };

export async function recordGamePlay(db, userId, game) {
    try {
        await db.collection('users').updateOne(
            { _id: userId, withdrawalCount: { $gte: 1 } }, // window only exists after the first withdrawal request
            { $inc: { [FIELD[game][0]]: 1, 'gameStats.plays': 1 } }
        );
    } catch (e) { console.error('gameStats play failed:', e?.message); }
}

export async function recordGameCoins(db, userId, game, amount) {
    if (!(amount > 0)) return;
    try {
        await db.collection('users').updateOne(
            { _id: userId, withdrawalCount: { $gte: 1 } },
            { $inc: { [FIELD[game][1]]: amount } }
        );
    } catch (e) { console.error('gameStats coins failed:', e?.message); }
}

// Deletes the old history and starts a fresh window. Called when a withdrawal request has been saved.
export async function resetGameStats(db, userId) {
    try {
        await db.collection('users').updateOne(
            { _id: userId },
            { $set: { gameStats: { since: new Date(), miniPlays: 0, miniCoins: 0, arrowPlays: 0, arrowCoins: 0, plays: 0 } } }
        );
    } catch (e) { console.error('gameStats reset failed:', e?.message); }
}

const n = (v) => (Number(v) || 0).toLocaleString('en-US');

// Plain numbers → text block (HTML-safe: only numbers go in).
export function gameStatsText(g) {
    const s = g || {};
    return `🤖 Mini Bot: <b>${n(s.miniPlays)}</b> plays · <b>${n(s.miniCoins)}</b> TXH COIN\n` +
           `🏹 Arrow Puzzle: <b>${n(s.arrowPlays)}</b> plays · <b>${n(s.arrowCoins)}</b> TXH COIN\n` +
           `🧮 Total: <b>${n((s.miniPlays || 0) + (s.arrowPlays || 0))}</b> plays · <b>${n((s.miniCoins || 0) + (s.arrowCoins || 0))}</b> TXH COIN`;
}
