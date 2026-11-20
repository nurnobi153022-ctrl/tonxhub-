// lib/botFighter.js — 🤖 BOT FIGHTER for Task › Daily › Ad Missions (used by lib/adMission.js).
//
// Ad Missions are already confirmed server-to-server (lib/adsgramS2S.js), so nobody can invent a reward from
// nothing. What a bot CAN still do is drive the real mini app (emulator / headless browser / auto-clicker) and
// finish missions back-to-back, faster and more evenly than a person. This module watches the timing of the
// player's last claims (adMission.claimTimes — claim timestamps, oldest → newest) and reacts:
//
//   Rule M1  "burst"      — the last MISSION_BURST_CLAIMS claims were each at most MISSION_BURST_MAX_SECONDS
//                           after the previous one. A person cannot finish a task ad that quickly, repeatedly.
//   Rule M2  "metronome"  — the last MISSION_METRONOME_CLAIMS claims are spaced almost identically
//                           (longest − shortest gap <= MISSION_METRONOME_SPREAD_SECONDS, every gap short).
//
// A rule hit is only a signal. The evidence (account age, withdrawals, referrals, multi-account flag …) is scored
// exactly like lib/botGuard.js does:
//   🔴 Likely script → account is LOCKED (accountLocked + 'bot_pattern': no withdraw, no ad rewards) and the claim is rejected.
//   🟡 / 🟢          → NOT locked, the claim still pays; the admin gets a "Suspicious — NOT locked" alert
//                      (Lock · Profile · Ban buttons, at most once per 24 h per user).
// The admin's 🔓 Unlock button also clears the claim history (see api/bot.js), so an unlocked player starts clean.
// All thresholds are tunable below.

import { lockForBotPattern } from './botGuard.js';

export const MISSION_BURST_CLAIMS = 4;              // Rule M1 — consecutive claims examined
export const MISSION_BURST_MAX_SECONDS = 6;         // Rule M1 — each one at most this long after the previous
export const MISSION_METRONOME_CLAIMS = 6;          // Rule M2 — consecutive claims examined
export const MISSION_METRONOME_SPREAD_SECONDS = 1;  // Rule M2 — max (longest − shortest) gap
export const MISSION_METRONOME_MAX_GAP_SECONDS = 120; // Rule M2 — only judge back-to-back claims
export const MISSION_HISTORY_KEEP = 8;              // claim timestamps stored per player

// times: claim timestamps in ms, oldest → newest, INCLUDING the claim being evaluated.
export function detectMissionBot(times) {
    const gapsOf = (arr) => arr.slice(1).map((t, i) => (t - arr[i]) / 1000);
    if (times.length >= MISSION_BURST_CLAIMS) {
        const gaps = gapsOf(times.slice(-MISSION_BURST_CLAIMS));
        if (gaps.every(g => g <= MISSION_BURST_MAX_SECONDS)) {
            return { rule: 'M1', detail: `${MISSION_BURST_CLAIMS} Ad Missions in a row, each ≤${MISSION_BURST_MAX_SECONDS}s after the previous (${gaps.map(g => g.toFixed(1) + 's').join(', ')})` };
        }
    }
    if (times.length >= MISSION_METRONOME_CLAIMS) {
        const gaps = gapsOf(times.slice(-MISSION_METRONOME_CLAIMS));
        if (Math.max(...gaps) <= MISSION_METRONOME_MAX_GAP_SECONDS && Math.max(...gaps) - Math.min(...gaps) <= MISSION_METRONOME_SPREAD_SECONDS) {
            return { rule: 'M2', detail: `${MISSION_METRONOME_CLAIMS} Ad Missions with a metronome-like rhythm (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}s apart)` };
        }
    }
    return null;
}

function buildEvidence(u, hit, times) {
    const ageDays = u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : 0;
    const wCount = u.withdrawalCount || 0;
    const recent = times.slice(-6);
    const gapTxt = recent.slice(1).map((t, i) => `${((t - recent[i]) / 1000).toFixed(1)}s`).join(', ') || '—';

    let scriptSignals = 0, realSignals = 0;
    if (hit.rule === 'M1') scriptSignals += 3;                 // several task ads back-to-back, seconds apart — not humanly possible
    if (hit.rule === 'M2') scriptSignals += 2;                 // identical rhythm
    if (u.multiAccountFlag) scriptSignals += 1;
    if (ageDays < 2) scriptSignals += 1;
    if (wCount === 0 && (u.lifetimeAdsWatched || 0) > 80 && ageDays < 3) scriptSignals += 1;
    if (ageDays >= 7) realSignals += 1;
    if (wCount > 0) realSignals += 1;
    if ((u.validReferralCount || 0) > 0) realSignals += 1;
    if (hit.rule === 'M2') realSignals += 1;                   // rhythm-only rule has the most false positives
    const likelyScript = scriptSignals >= 3 && scriptSignals > realSignals;
    const hint = likelyScript ? '🔴 Likely script'
               : realSignals >= 3 && realSignals > scriptSignals ? '🟢 Likely real user'
               : '🟡 Unclear — check profile';
    const text =
        `\n<b>Evidence</b>\n` +
        `Name: ${u.firstName || '—'} (@${u.telegramUsername || 'none'})\n` +
        `Account age: ${ageDays}d · Balance: ${u.wtcBalance || 0} TXH COIN · Lifetime: ${u.lifetimeWtcEarned || 0} TXH COIN\n` +
        `Withdrawals: ${wCount} · Valid referrals: ${u.validReferralCount || 0}\n` +
        `Multi-account flag: ${u.multiAccountFlag ? 'YES 🚩' : 'No'}\n` +
        `Gaps between Ad Mission claims: ${gapTxt}\n` +
        `Hint: <b>${hint}</b> (script ${scriptSignals} / real ${realSignals})\n`;
    return { text, likelyScript };
}

// Looks at the claim being made (`times` already contains it). Returns:
//   { blocked: true }  — the account is (now) locked as a script → the caller must refuse the claim
//   { blocked: false } — fine, or only reported to the admin → the claim may pay
export async function fightMissionBot(db, userId, times, tgSend) {
    try {
        const hit = detectMissionBot(times);
        if (!hit) return { blocked: false };
        const user = await db.collection('users').findOne({ _id: userId });
        if (!user) return { blocked: false };
        let evidence = null;
        try { evidence = buildEvidence(user, hit, times); } catch { /* evidence is best-effort */ }
        const locked = await lockForBotPattern(db, userId, hit, tgSend, 'Section: Ad Missions', { evidence });
        return { blocked: !!locked, rule: hit.rule };
    } catch (e) {
        console.error('botFighter error:', e?.message); // the guard must never break the reward flow
        return { blocked: false };
    }
}
