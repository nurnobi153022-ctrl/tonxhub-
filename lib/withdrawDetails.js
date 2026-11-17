// lib/withdrawDetails.js — saved withdrawal details (Binance UID / Tonkeeper address)
//
//   • validateWithdrawDetails(method, raw)  — per-method input validation (server is the source of truth;
//                                              index.html carries a display copy of the same rules)
//   • getSavedDetails(user)                 — per-method { value, changesUsed, changesLeft, locked } snapshot
//   • migrateLegacyDetails(users, user)     — folds the old single "locked wallet" into the per-method record
//   • changeWithdrawDetails(...)            — the ONLY way to change saved details: one atomic DB update that
//                                              re-checks the counter, so refresh / re-login / replayed or tampered
//                                              requests can never exceed MAX_WITHDRAW_DETAIL_CHANGES per method.
//
// Storage (users collection):
//   withdrawDetails: { binance: { value, changesUsed, savedAt }, tonkeeper: { ... } }
// The first value is saved with a withdrawal request (changesUsed = 0, not a "change"). Each later successful
// change does changesUsed += 1. Failed / invalid / cancelled attempts never touch the counter.

import { WITHDRAW_METHODS, MAX_WITHDRAW_DETAIL_CHANGES } from './constants.js';

// ── Tonkeeper: unchanged rule from api/withdraw.js ─────────────────────────────
// Tonkeeper/TON addresses are base64url or raw "0:hex". No whitespace, no HTML characters.
export const TONKEEPER_DETAILS_RE = /^[A-Za-z0-9_\-:.+\/=]{5,100}$/;

// ── Binance UID ────────────────────────────────────────────────────────────────
// A Binance UID is a plain positive integer rendered in decimal. Today's UIDs are 8–10 digits; the accepted
// range is deliberately wider (6–12 digits) so no legitimate UID — old or future — is rejected, while every
// wallet / deposit address (0x…, T…, UQ…, bc1…, 0:hex …) is excluded because it contains non-digits or is far
// longer. We do NOT try to guess more than that: a number alone can't prove it belongs to a Binance account.
export const BINANCE_UID_RE = /^[1-9][0-9]{5,11}$/;
export const BINANCE_UID_WARNING = 'Binance UID is required. Wallet addresses are not accepted.';

export function validateBinanceUid(raw) {
    if (typeof raw !== 'string') return { ok: false, error: 'invalid_binance_uid', message: BINANCE_UID_WARNING };
    const v = raw.trim();
    if (!v) return { ok: false, error: 'invalid_binance_uid', message: 'Please enter your Binance UID.' };
    if (!/^[0-9]+$/.test(v)) {   // ASCII digits only: letters, 0x…, spaces, dashes, unicode digits … all rejected
        return { ok: false, error: 'invalid_binance_uid', message: `That is not a Binance UID — a UID contains digits only. ${BINANCE_UID_WARNING}` };
    }
    if (v[0] === '0') return { ok: false, error: 'invalid_binance_uid', message: 'A Binance UID never starts with 0. Copy it again from your Binance profile.' };
    if (v.length < 6 || v.length > 12) {
        return { ok: false, error: 'invalid_binance_uid', message: 'A Binance UID is a number of 6–12 digits (usually 8–10). Copy it again from your Binance profile.' };
    }
    return { ok: true, value: v };
}

export function validateTonkeeperAddress(raw) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!TONKEEPER_DETAILS_RE.test(v)) {
        return { ok: false, error: 'invalid_address', message: 'That address/UID does not look valid. Check it and try again.' };
    }
    return { ok: true, value: v };
}

export function isWithdrawMethod(method) {
    // hasOwn: plain WITHDRAW_METHODS[method] would also accept "__proto__" / "constructor".
    return typeof method === 'string' && Object.hasOwn(WITHDRAW_METHODS, method);
}

// → { ok:true, value } | { ok:false, error, message }
export function validateWithdrawDetails(method, raw) {
    if (!isWithdrawMethod(method)) return { ok: false, error: 'invalid_method', message: 'Invalid withdrawal method.' };
    return method === 'binance' ? validateBinanceUid(raw) : validateTonkeeperAddress(raw);
}

// ── saved details snapshot ──────────────────────────────────────────────────────
function entryFor(user, method) {
    const e = user?.withdrawDetails?.[method];
    if (e && typeof e.value === 'string' && e.value) return { value: e.value, changesUsed: Math.max(0, Number(e.changesUsed) || 0) };
    // legacy single locked wallet (before per-method details existed)
    if (user?.lockedWalletMethod === method && user?.lockedWalletAddress) {
        return { value: user.lockedWalletAddress, changesUsed: user.walletChangeUsed ? 1 : 0, legacy: true };
    }
    return null;
}

// { binance: {value, changesUsed, changesLeft, locked, legacy?} | null, tonkeeper: ... }
export function getSavedDetails(user) {
    const out = {};
    for (const method of Object.keys(WITHDRAW_METHODS)) {
        const e = entryFor(user, method);
        out[method] = e && {
            ...e,
            changesLeft: Math.max(0, MAX_WITHDRAW_DETAIL_CHANGES - e.changesUsed),
            locked: e.changesUsed >= MAX_WITHDRAW_DETAIL_CHANGES,
        };
    }
    return out;
}

// What /api/withdraw?action=status returns — one entry per method, always present.
export function detailsForClient(user) {
    const saved = getSavedDetails(user);
    const out = {};
    for (const method of Object.keys(WITHDRAW_METHODS)) {
        const e = saved[method];
        out[method] = {
            value: e ? e.value : null,
            changesUsed: e ? e.changesUsed : 0,
            changesLeft: e ? e.changesLeft : MAX_WITHDRAW_DETAIL_CHANGES,
            maxChanges: MAX_WITHDRAW_DETAIL_CHANGES,
            locked: e ? e.locked : false,
        };
    }
    return out;
}

// Old accounts only have lockedWalletMethod/Address (+ walletChangeUsed). Copy that into withdrawDetails once, so
// the atomic counter filter below has a real document to work on. Idempotent; never overwrites an existing record.
// Returns the user object with withdrawDetails filled in locally.
export async function migrateLegacyDetails(users, user) {
    if (!user) return user;
    const m = user.lockedWalletMethod;
    if (!m || !user.lockedWalletAddress || !isWithdrawMethod(m)) return user;
    if (user.withdrawDetails?.[m]?.value) return user;
    const rec = { value: user.lockedWalletAddress, changesUsed: user.walletChangeUsed ? 1 : 0, savedAt: new Date(), migrated: true };
    await users.updateOne({ _id: user._id, [`withdrawDetails.${m}.value`]: { $exists: false } }, { $set: { [`withdrawDetails.${m}`]: rec } });
    // re-read so a concurrent writer's record wins over our local copy
    const fresh = await users.findOne({ _id: user._id });
    return fresh || { ...user, withdrawDetails: { ...(user.withdrawDetails || {}), [m]: rec } };
}

// ── the one change path ─────────────────────────────────────────────────────────
// → { ok:true, value, changesUsed, changesLeft, locked } | { ok:false, status, error, message }
export async function changeWithdrawDetails(db, userId, method, rawNew) {
    const users = db.collection('users');
    if (!isWithdrawMethod(method)) return { ok: false, status: 400, error: 'invalid_method', message: 'Invalid withdrawal method.' };

    const v = validateWithdrawDetails(method, rawNew);
    if (!v.ok) return { ok: false, status: 400, error: v.error, message: v.message };

    let user = await users.findOne({ _id: userId });
    if (!user) return { ok: false, status: 404, error: 'user_not_found' };
    if (user.isBanned) return { ok: false, status: 403, error: 'banned' };
    if (user.accountLocked) return { ok: false, status: 403, error: 'account_locked', message: 'Your account is temporarily locked for review. Please contact support.' };
    user = await migrateLegacyDetails(users, user);

    const cur = getSavedDetails(user)[method];
    const label = WITHDRAW_METHODS[method].label;
    if (!cur) {
        return { ok: false, status: 400, error: 'no_saved_details', message: `No ${label} is saved yet — it is saved with your first withdrawal request.` };
    }
    if (cur.locked) return lockedResult(label);
    if (v.value === cur.value) {
        // nothing would change → not a change, never costs an attempt
        return { ok: false, status: 400, error: 'same_details', message: `That is already your saved ${label}.` };
    }

    const base = `withdrawDetails.${method}`;
    // Atomic: the filter re-checks BOTH the counter and the value we based this on. Two parallel requests (or a
    // replayed one) cannot both pass — the first changes the value/counter, the second then matches nothing.
    const upd = await users.findOneAndUpdate(
        { _id: userId, [`${base}.value`]: cur.value, [`${base}.changesUsed`]: { $lt: MAX_WITHDRAW_DETAIL_CHANGES } },
        { $set: { [`${base}.value`]: v.value, [`${base}.updatedAt`]: new Date() }, $inc: { [`${base}.changesUsed`]: 1 } },
        { returnDocument: 'after' }
    );
    if (!upd) {
        const again = getSavedDetails(await users.findOne({ _id: userId }) || {})[method];
        if (again?.locked) return lockedResult(label);
        return { ok: false, status: 409, error: 'details_conflict', message: 'Your saved details just changed. Please refresh and try again.' };
    }

    // audit trail (best effort — the change itself is already committed)
    db.collection('withdraw_detail_changes').insertOne({ userId, method, from: cur.value, to: v.value, attempt: (upd.withdrawDetails[method].changesUsed), at: new Date() }).catch(() => {});

    const after = getSavedDetails(upd)[method];
    return { ok: true, value: after.value, changesUsed: after.changesUsed, changesLeft: after.changesLeft, locked: after.locked, maxChanges: MAX_WITHDRAW_DETAIL_CHANGES };
}

function lockedResult(label) {
    return {
        ok: false, status: 403, error: 'details_locked',
        message: `You have used all ${MAX_WITHDRAW_DETAIL_CHANGES} change attempts. Your withdrawal details are now permanently locked.`,
        method: label,
    };
}
