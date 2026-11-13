// lib/referral.js — referral milestone rewards (NEW referral system).
//
// The REFERRER is paid TXH COIN, once per milestone per referred friend (real numbers: REFERRAL_REWARDS in lib/constants.js):
//   1. friend joins through the invite link ........ 200  (paid at signup — api/user.js passes { joined: true })
//   2. friend completes 5 tasks ..................... 100  (api/earn.js)
//   3. friend completes 10 spins .................... 200  (api/earn.js)
//   4. friend completes the game 5 times ............ 300  (lib/arrowPuzzle.js, server-verified wins)
//   5. friend's FIRST withdrawal is approved ........ 200  (api/bot.js finalizeWithdrawal, approval only)
//
// Each milestone is paid ONCE: the referred user's document carries a once-only flag per milestone
// (referralStep1Done = join, Step2Done = tasks, Step5Done = spins, Step6Done = games, Step7Done = first withdrawal;
// the old key names are kept for milestones whose meaning is unchanged so nothing already paid is paid twice).
// The flag check-and-set is ATOMIC (findOneAndUpdate), so two near-simultaneous triggers can never both pay.
// If the payout fails (referrer locked / banned / missing / DB error) the flag is taken back so the milestone is
// paid on a later call instead of being lost. Locked/banned referrers are never paid — the one anti-abuse gate kept.
//
// Reward goes straight to wtcBalance and also to `referralWtcEarned` (the real number shown on the Refer tab).
//
// "Valid referral" (the withdrawal gate in api/withdraw.js) is separate from the rewards: the friend needs
// REFERRAL_TASK_COUNT tasks AND REFERRAL_VALID_AD_COUNT ads (tracked by referralValidDone). Unchanged.

import {
    REFERRAL_REWARDS,
    REFERRAL_TASK_COUNT,
    REFERRAL_SPIN_COUNT,
    REFERRAL_GAME_COUNT,
    REFERRAL_VALID_AD_COUNT,
} from './constants.js';
import { tgSend } from './telegram.js';

// sent to the REFERRER the moment one of their referrals
// becomes "valid" (see the combined tasks+ads check below). This valid
// referral is what api/withdraw.js spends — 1 per withdrawal, after the
// user's first (free) one.
function validReferralNotification() {
    return (
        `🎉 <b>Congratulations!</b>\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked <b>1 valid referral</b> — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`
    );
}

// stats = { joined?, completedTasksCount?, lifetimeSpins?, gameWinsCount?, firstWithdrawal? }
// — pass whichever one just changed; the counters are re-read from the DB on every call (catch-up), so a missed
// trigger or a failed payout is paid on the next call. `joined` and `firstWithdrawal` are one-shot events:
// they are only ever passed by their own caller and are never reconstructed by the catch-up.
export async function maybeAwardReferralMilestones(db, referredUserId, stats = {}) {
    const users = db.collection('users');
    const referredUser = await users.findOne(
        { _id: referredUserId },
        {
            projection: {
                referredBy: 1, referralStep1Done: 1, referralStep2Done: 1, referralStep5Done: 1, referralStep6Done: 1, referralStep7Done: 1, referralValidDone: 1,
                completedTasks: 1, lifetimeAdsWatched: 1, lifetimeSpins: 1,
            },
        }
    );
    if (!referredUser || !referredUser.referredBy) return; // nobody referred this user
    if (referredUser.referredBy === referredUserId) return; // self-referral guard — defense in depth

    const referrerId = referredUser.referredBy;

    // 🔁 CATCH-UP: callers pass only the ONE stat that just changed. Fill the other counters from the referred user's
    // real, current numbers so EVERY call re-checks every counter-based milestone and pays whatever is due (once).
    try {
        const arrow = await db.collection('arrowPuzzle').findOne({ _id: referredUserId }, { projection: { wins: 1, done: 1 } });
        stats = {
            completedTasksCount: (referredUser.completedTasks || []).length,
            lifetimeSpins: Math.floor(Number(referredUser.lifetimeSpins) || 0),
            gameWinsCount: Math.max(Math.max(0, Math.floor(Number(arrow?.wins) || 0)), new Set(arrow?.done || []).size),
            ...stats,
        };
    } catch (e) { /* catch-up is best-effort — the passed stats still work */ }

    const steps = [
        // 1. join — one-shot event, fired at signup
        { key: 'referralStep1Done', met: !!stats.joined, reward: REFERRAL_REWARDS.join },
        // 2. tasks
        { key: 'referralStep2Done', met: stats.completedTasksCount !== undefined && stats.completedTasksCount >= REFERRAL_TASK_COUNT, reward: REFERRAL_REWARDS.tasks },
        // 3. spins (lifetime)
        { key: 'referralStep5Done', met: stats.lifetimeSpins !== undefined && stats.lifetimeSpins >= REFERRAL_SPIN_COUNT, reward: REFERRAL_REWARDS.spins },
        // 4. game completions (Arrow Puzzle, server-verified wins)
        { key: 'referralStep6Done', met: stats.gameWinsCount !== undefined && stats.gameWinsCount >= REFERRAL_GAME_COUNT, reward: REFERRAL_REWARDS.games },
        // 5. first withdrawal — one-shot event, fired on admin approval only (rejected withdrawals never pay)
        { key: 'referralStep7Done', met: !!stats.firstWithdrawal, reward: REFERRAL_REWARDS.firstWithdraw },
    ];

    for (const step of steps) {
        if (!(step.reward > 0)) continue; // reward set to 0 = milestone switched off — never flagged, never paid
        if (!step.met || referredUser[step.key]) continue;

        // ⚠️ ATOMIC — flag-check আর flag-set একই operation-এ। দুটো concurrent
        // call এলে একটাই এই filter ($ne:true) পাস করবে, অন্যটা null ফেরত পাবে
        // এবং নিচের reward-credit স্কিপ করবে।
        const claimed = await users.findOneAndUpdate(
            { _id: referredUserId, [step.key]: { $ne: true } },
            { $set: { [step.key]: true } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // অন্য concurrent call কিছু মিলিসেকেন্ড আগেই claim করে ফেলেছে

        let paid = null;
        try {
            paid = await users.findOneAndUpdate(
                // ⚠️ locked/banned referrer skipped — the one anti-abuse gate kept.
                { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                { $inc: { wtcBalance: step.reward, lifetimeWtcEarned: step.reward, referralWtcEarned: step.reward } }
            );
        } catch (e) { paid = null; }
        // ⚠️ the reward was NOT paid (referrer locked / banned / missing, or a DB error) → take the "done" flag back, so the
        // milestone is paid on a later call (e.g. after the admin unlocks the referrer) instead of being lost for good.
        if (!paid) {
            await users.updateOne({ _id: referredUserId }, { $unset: { [step.key]: '' } }).catch(() => {});
            await db.collection('referralRewardLog').updateOne({ referredUserId, step: step.key, paid: false }, { $set: { referrerId, reward: step.reward, at: new Date() } }, { upsert: true }).catch(() => {});
        }
    }

    // ── "Valid referral" — ⚠️ CHANGED (this update): এখন আলাদা করে চেক হয়,
    //    ধাপ ৩-এর reward-fire-এর সাথে বাঁধা না। দুইটা শর্তই লাগবে একসাথে:
    //    কমপক্ষে REFERRAL_TASK_COUNT (৫) tasks AND কমপক্ষে
    //    REFERRAL_VALID_AD_COUNT (২০) ads — তবেই referrer-এর জন্য এই
    //    referral "valid" গণ্য হবে, withdraw-এর জন্য খরচযোগ্য। DB-তে থাকা
    //    referred user-এর real, up-to-date counts দিয়ে check হচ্ছে (এই
    //    call-এর stats parameter দিয়ে না — সেখানে একবারে একটাই stat আসে)। ──
    const tasksOk = (referredUser.completedTasks || []).length >= REFERRAL_TASK_COUNT;
    const adsOk = (referredUser.lifetimeAdsWatched || 0) >= REFERRAL_VALID_AD_COUNT;
    if (tasksOk && adsOk && !referredUser.referralValidDone) {
        const claimedValid = await users.findOneAndUpdate(
            { _id: referredUserId, referralValidDone: { $ne: true } },
            { $set: { referralValidDone: true } },
            { returnDocument: 'after' }
        );
        if (claimedValid) {
            const referrerUpdate = await users.findOneAndUpdate(
                { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                { $inc: { validReferralCount: 1 } },
                { returnDocument: 'after' }
            );
            if (referrerUpdate) {
                tgSend(referrerId, validReferralNotification()).catch(() => {});
            } else {
                // referrer locked / banned / missing: give the flag back so this valid referral is counted later, not lost
                await users.updateOne({ _id: referredUserId }, { $unset: { referralValidDone: '' } }).catch(() => {});
            }
        }
    }
}
