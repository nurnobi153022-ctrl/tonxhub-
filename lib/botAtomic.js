// lib/botAtomic.js — ⚛️ ATOMIC SYSTEM for the Telegram bot (api/bot.js).
//
// Rule: anything that must happen ONCE (credit coins, create a gift, reset the week, process an update) is decided
// by ONE database write that can only succeed once — never by "read, check in JS, then write".
//
//   claimUpdate(db, update)         Telegram re-delivers a webhook update when the answer is slow or lost. Every
//                                   update_id is claimed with a unique-_id insert (collection `botUpdates`, TTL 1 day);
//                                   the second delivery finds the claim and is dropped. Fails OPEN on a DB error.
//   takeAdminState(adminId, step)   Read-AND-delete the admin's wizard state in one findOneAndDelete, only if it is
//                                   at `step`. A double tap on a confirm button gets the state ONCE; the other tap gets null.
//   acquireLock(db, key, ttlMs)     Cross-instance mutex (collection `botLocks`): true for exactly one caller until
//                                   releaseLock() or the TTL ends (TTL protects against a crashed function).
//   releaseLock(db, key)
//   adjustBalance(users, id, amt)   $inc of the coin balance in one conditional update. A deduction can never push
//                                   the balance below 0 (the filter requires wtcBalance >= amount).

export const BOT_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

let indexesEnsured = false;
function ensureIndexes(db) {
    if (indexesEnsured) return;
    indexesEnsured = true;
    db.collection('botUpdates').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { indexesEnsured = false; });
    db.collection('botLocks').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { indexesEnsured = false; });
}

// true = first time we see this update (process it); false = duplicate delivery (drop it).
export async function claimUpdate(db, update) {
    const id = update && update.update_id;
    if (!Number.isFinite(id)) return true;
    try {
        ensureIndexes(db);
        await db.collection('botUpdates').insertOne({ _id: id, at: new Date(), expireAt: new Date(Date.now() + BOT_UPDATE_TTL_MS) });
        return true;
    } catch (e) {
        if (e?.code === 11000) return false;   // already claimed → duplicate delivery
        console.error('claimUpdate error (fail open):', e?.message);
        return true;                            // never block the bot because of a guard problem
    }
}

// Returns the wizard state (and deletes it) only if the admin is at `step`; otherwise null. Works with the same
// document shape as lib/adminState.js: { _id: adminId, state: {...} }.
export async function takeAdminState(db, adminId, step) {
    const doc = await db.collection('adminState').findOneAndDelete({ _id: String(adminId), 'state.step': step });
    const d = doc && doc.value !== undefined ? doc.value : doc;   // driver v5 vs v6 return shape
    return d?.state || null;
}

export async function acquireLock(db, key, ttlMs = 60000) {
    ensureIndexes(db);
    const now = new Date();
    try {
        // matches only a missing or EXPIRED lock; if a live lock exists the upsert tries to insert the same _id → 11000
        await db.collection('botLocks').updateOne(
            { _id: key, expireAt: { $lte: now } },
            { $set: { at: now, expireAt: new Date(now.getTime() + ttlMs) } },
            { upsert: true }
        );
        return true;
    } catch (e) {
        if (e?.code === 11000) return false;
        throw e;
    }
}

export async function releaseLock(db, key) {
    await db.collection('botLocks').deleteOne({ _id: key }).catch(() => {});
}

// amt may be negative (a deduction). Returns the updated user document, or null when the user does not exist or the
// deduction would make the balance negative.
export async function adjustBalance(users, userId, amt) {
    const filter = amt < 0 ? { _id: userId, wtcBalance: { $gte: -amt } } : { _id: userId };
    return users.findOneAndUpdate(filter, { $inc: { wtcBalance: amt, lifetimeWtcEarned: amt } }, { returnDocument: 'after' });
}
