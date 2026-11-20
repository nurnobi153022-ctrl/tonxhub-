// lib/botVelocity.js — 🚀 VELOCITY SYSTEM for the Telegram bot (api/bot.js).
//
// "Velocity" = how much of something happens per hour. The admin buttons can create coins out of thin air
// (Send TXH COIN, Gift), wipe a balance, or ban accounts. A fat-finger loop, a stuck double-tap or a hijacked admin
// Telegram account could do that hundreds of times in minutes. Each of those actions now spends from an HOURLY budget:
//
//   key                 what it counts                                   default per hour (env to change)
//   ─────────────────────────────────────────────────────────────────────────────────────────────────────
//   admin_send          Send TXH COIN + Gift actions                     30 actions · 1,000,000 coins in total
//                       (ADMIN_SEND_MAX_PER_HOUR, ADMIN_SEND_MAX_COIN_PER_HOUR)
//   admin_destructive   ban · confiscate balance · ban-network (that     60 actions · 2,000 accounts
//                       one counts every account it bans)
//                       (ADMIN_DESTRUCTIVE_MAX_PER_HOUR, ADMIN_DESTRUCTIVE_MAX_ACCOUNTS_PER_HOUR)
//
// The budget is spent with ONE conditional upsert (collection `botVelocity`, one document per key+actor+hour, TTL
// cleanup), so two requests at the same moment can never both squeeze through the last slot — no read-then-write.
// Over budget → the action is refused with how long until the budget renews. Limits are generous on purpose:
// they stop runaways, not normal admin work. Raise them with the env vars above if you really need to.

const num = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v > 0 ? v : def; };

export const VELOCITY = {
    admin_send: {
        windowMs: 60 * 60 * 1000,
        get maxCount() { return num('ADMIN_SEND_MAX_PER_HOUR', 30); },
        get maxSum() { return num('ADMIN_SEND_MAX_COIN_PER_HOUR', 1000000); },
        label: 'coin sends / gifts',
    },
    admin_destructive: {
        windowMs: 60 * 60 * 1000,
        get maxCount() { return num('ADMIN_DESTRUCTIVE_MAX_PER_HOUR', 60); },
        get maxSum() { return num('ADMIN_DESTRUCTIVE_MAX_ACCOUNTS_PER_HOUR', 2000); },
        label: 'bans / balance confiscations',
    },
};

let indexEnsured = false;
function ensureIndex(db) {
    if (indexEnsured) return;
    indexEnsured = true;
    db.collection('botVelocity').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { indexEnsured = false; });
}

// Try to spend one action (and `amount` of the sum budget) for `actorId`.
// Returns { ok: true } or { ok: false, retryMin, why }.
// Fails OPEN on a database error — a guard problem must never block the admin.
export async function spendVelocity(db, key, actorId, amount = 0) {
    const cfg = VELOCITY[key];
    if (!cfg) return { ok: true };
    const amt = Math.max(0, Math.abs(Number(amount) || 0));
    const now = Date.now();
    const bucket = Math.floor(now / cfg.windowMs);
    const retryMin = Math.max(1, Math.ceil(((bucket + 1) * cfg.windowMs - now) / 60000));
    const maxCount = cfg.maxCount, maxSum = cfg.maxSum;
    if (amt > maxSum) return { ok: false, retryMin, why: `a single action of ${amt.toLocaleString()} is over the hourly limit of ${maxSum.toLocaleString()}` };
    try {
        ensureIndex(db);
        // matches only while there is room for this action; a full bucket makes the upsert collide on _id → 11000
        await db.collection('botVelocity').updateOne(
            { _id: `${key}:${actorId}:${bucket}`, n: { $lt: maxCount }, sum: { $lte: maxSum - amt } },
            { $inc: { n: 1, sum: amt }, $setOnInsert: { expireAt: new Date((bucket + 2) * cfg.windowMs) } },
            { upsert: true }
        );
        return { ok: true };
    } catch (e) {
        if (e?.code === 11000) return { ok: false, retryMin, why: `hourly limit for ${cfg.label} reached (${maxCount} actions / ${maxSum.toLocaleString()} total)` };
        console.error('spendVelocity error (fail open):', e?.message);
        return { ok: true };
    }
}

export const velocityMessage = (r) =>
    `🚦 <b>Velocity limit</b>\n\nNot done — ${r.why}.\nThe budget renews in about <b>${r.retryMin} min</b>. ` +
    `(Raise it with the ADMIN_* env vars if this is expected.)`;
