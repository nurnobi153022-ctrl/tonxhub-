// lib/suspicious.js — SUSPICIOUS flag for ad-reward abuse.
//
// RULE: an ad (Adsgram INTERSTITIAL / game ad) must be on screen for at least INT_AD_MIN_VIEW_SECONDS (7 s) before any
// reward is paid. Every reward path rejects a shorter view BEFORE paying. This module is the second line of defence:
//   • auditRewardView()  — called right AFTER a reward was credited. If the view time behind that reward is missing or
//                          under 7 s, the user is flagged SUSPICIOUS (they received a reward without the minimum watch).
//   • flagSuspicious()   — also called when a client reports a view time that the SERVER's own timeline proves impossible.
//
// The flag only MARKS the account (users.suspicious = true + a `suspiciousLog` row + one admin alert per user per day).
// It never blocks the reward flow itself, never throws, and is shown to the admin in the withdrawal request message.

import { tgSend } from './telegram.js';
import { INT_AD_MIN_VIEW_SECONDS } from './constants.js';

export async function flagSuspicious(db, userId, { source, reason, viewMs = null, extra = null } = {}) {
    try {
        const uid = String(userId), now = new Date();
        await db.collection('suspiciousLog').insertOne({
            userId: uid, source: String(source || 'unknown'), reason: String(reason || 'ad_view_under_minimum'),
            viewMs: Number.isFinite(Number(viewMs)) ? Number(viewMs) : null, minViewSeconds: INT_AD_MIN_VIEW_SECONDS, extra, createdAt: now,
        });
        const users = db.collection('users');
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        // $set/$inc always; the admin alert only when this user was not already alerted in the last 24 h (atomic claim)
        await users.updateOne({ _id: uid }, {
            $set: { suspicious: true, suspiciousAt: now, suspiciousReason: `${source || 'unknown'}: ${reason || 'ad_view_under_minimum'}` },
            $inc: { suspiciousCount: 1 },
        });
        const adminId = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_ID);
        if (!adminId) return;
        const first = await users.findOneAndUpdate(
            { _id: uid, $or: [{ suspiciousAlertedAt: { $exists: false } }, { suspiciousAlertedAt: { $lte: dayAgo } }] },
            { $set: { suspiciousAlertedAt: now } }
        );
        if (first) {
            tgSend(adminId,
                `⚠️ <b>SUSPICIOUS user</b>\n\nUser <code>${uid}</code> received an ad reward without a valid ${INT_AD_MIN_VIEW_SECONDS}-second watch ` +
                `(source: <b>${String(source || 'unknown')}</b>, ${String(reason || 'ad_view_under_minimum')}` +
                `${Number.isFinite(Number(viewMs)) ? `, reported view ${Math.round(Number(viewMs))} ms` : ''}).`,
                { reply_markup: { inline_keyboard: [[{ text: '🔎 Review this account', callback_data: `lookup_${uid}` }]] } }
            ).catch(() => {});
        }
    } catch (e) { console.error('flagSuspicious failed:', e?.message); }
}

// Call AFTER a reward was credited. viewMs = the on-screen time that reward was based on (null/undefined = unknown).
// Returns true when the user was flagged.
export async function auditRewardView(db, userId, { source, viewMs, minMs = INT_AD_MIN_VIEW_SECONDS * 1000 } = {}) {
    const v = Number(viewMs);
    if (Number.isFinite(v) && v >= minMs) return false;
    await flagSuspicious(db, userId, { source, reason: Number.isFinite(v) ? 'rewarded_under_min_view' : 'rewarded_without_view_time', viewMs: Number.isFinite(v) ? v : null });
    return true;
}
