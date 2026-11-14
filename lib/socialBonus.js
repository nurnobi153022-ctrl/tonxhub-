// lib/socialBonus.js — OPTIONAL "Social Sharing Bonus" (+15 TXH COIN) for Mini Bot and Arrow Puzzle. Served through api/earn.js; the
// group posts are observed by the bot webhook (api/bot.js → recordGroupPost).
//
//   { action: 'socialBonusOpen',    initData, bonusId }   user tapped "Copy & Open Telegram Group" (progress marker only, pays nothing)
//   { action: 'socialBonusClaim',   initData, bonusId }   "I've Posted It · Claim +15"  → pays ONLY if the bot has verified the post
//   { action: 'socialBonusDismiss', initData, bonusId }   "No Thanks"
//   { action: 'socialBonusStatus',  initData }            an offer the user already opened but has not claimed yet (resume after returning)
//
// Flow
//   1. createSocialBonus() is called by lib/miniBot.js / lib/arrowPuzzle.js right after the 30-coin reward was paid (2nd verified ad).
//      It creates ONE bonus transaction {_id:'sb_<uuid>'}, generates a unique message (lib/socialMessage.js) and stores it with the
//      transaction. The message never changes afterwards.
//   2. The user copies that exact message and posts it in the official group.
//   3. The bot receives the group message (api/bot.js webhook, verified by the Telegram secret token) and recordGroupPost() stores
//      the proof on the bonus — but ONLY if: it is the official group, the Telegram sender id is the bonus owner, the text equals the
//      generated message, it is not forwarded / anonymous, and it was sent after the bonus was created and before it expired.
//   4. socialBonusClaim pays SOCIAL_BONUS_POINTS once. A button click alone never pays: with no stored proof the answer is 'not_verified'.
//
// Collections
//   socialBonuses      one doc per bonus transaction (message, status, proof, timestamps)   status: pending | claimed | declined | expired
//   socialBonusRewards reward transaction history, _id = 'socialbonus:<bonusId>' (unique → a bonus can never pay twice)
//   socialBonusKeys    uniqueness guards by _id:  'gate:<game>:<gateId>' (one bonus per game reward)  ·  'msg:<sha256>' (one bonus per message)
// Uniqueness lives in `_id` on purpose: it is enforced by MongoDB with no extra index to create.

import crypto from 'crypto';
import { generateSocialMessage, hashMessage } from './socialMessage.js';
import { SOCIAL_BONUS_POINTS, SOCIAL_BONUS_GROUP_URL, SOCIAL_BONUS_GROUP_USERNAME, SOCIAL_BONUS_TTL_MS } from './constants.js';

const GAMES = new Set(['mini', 'arrow']);
const KEY_KEEP_MS = 90 * 24 * 3600 * 1000;   // guard keys are purged after 90 days (TTL index on `purgeAt`)
const UNCLAIMED_KEEP_MS = 30 * 24 * 3600 * 1000;
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const cols = (db) => ({ bonuses: db.collection('socialBonuses'), keys: db.collection('socialBonusKeys'), rewards: db.collection('socialBonusRewards') });
const isDup = (e) => e?.code === 11000;

const publicBonus = (b) => ({
    id: b._id, game: b.game, message: b.message, points: b.points, groupUrl: SOCIAL_BONUS_GROUP_URL,
    expiresAt: b.expiresAt.getTime(), opened: !!b.openedAt, posted: !!b.posted,
});

// ── 1) create (called from the two game reward handlers; never throws, returns null when no offer can be made) ──────────
export async function createSocialBonus(db, userId, { game, gateId }) {
    try {
        if (!GAMES.has(game) || !isStr(gateId, 100)) return null;
        const { bonuses, keys } = cols(db);
        const id = 'sb_' + crypto.randomUUID(), now = Date.now();
        const purgeAt = new Date(now + KEY_KEEP_MS);

        // one offer per game reward — a replay of the same reward can never open a second one
        try { await keys.insertOne({ _id: `gate:${game}:${gateId}`, bonusId: id, userId, at: new Date(now), purgeAt }); }
        catch (e) { if (isDup(e)) return null; throw e; }

        // a message nobody has ever been given: reserve its hash, or generate another one
        let message = null, hash = null;
        for (let i = 0; i < 20 && !message; i++) {
            const m = generateSocialMessage({ game }), h = hashMessage(m);
            try { await keys.insertOne({ _id: `msg:${h}`, bonusId: id, userId, at: new Date(now), purgeAt }); message = m; hash = h; }
            catch (e) { if (!isDup(e)) throw e; }
        }
        const release = () => keys.deleteMany({ _id: { $in: [`gate:${game}:${gateId}`, hash ? `msg:${hash}` : '-'] }, bonusId: id }).catch(() => {});
        if (!message) { await release(); return null; }

        const doc = {
            _id: id, userId, game, gateId, points: SOCIAL_BONUS_POINTS, message, messageHash: hash, status: 'pending',
            createdAt: new Date(now), expiresAt: new Date(now + SOCIAL_BONUS_TTL_MS), purgeAt: new Date(now + SOCIAL_BONUS_TTL_MS + UNCLAIMED_KEEP_MS),
            openedAt: null, posted: null, claimedAt: null,
        };
        try { await bonuses.insertOne(doc); } catch (e) { await release(); throw e; }
        return publicBonus(doc);
    } catch (e) { console.error('createSocialBonus failed:', e?.message); return null; }
}

// ── 2) the bot saw a message in a group ─────────────────────────────────────────────────────────────────────────────────
export function isOfficialGroup(chat) {
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return false;
    const envId = String(process.env.SOCIAL_BONUS_GROUP_ID || '').trim();
    if (envId) return String(chat.id) === envId; // numeric id configured → it is the strongest check, use only that
    return String(chat.username || '').toLowerCase() === SOCIAL_BONUS_GROUP_USERNAME;
}

// Called by api/bot.js for every group message. Cheap for unrelated groups/messages (no database access), never throws.
// Returns a short reason string (used by tests / logs only).
async function evaluateGroupPost(db, msg) {
    try {
        if (!msg || !msg.from || msg.from.is_bot) return 'ignored';
        if (!isOfficialGroup(msg.chat)) {
            // diagnostics: a TON X HUB post arrived from a group that is NOT the configured one → shows the real id / username to configure
            if (msg.chat && typeof msg.text === 'string' && msg.text.includes('TON X HUB')) console.log(`socialBonus: post from a non-official group id=${msg.chat.id} username=${msg.chat.username || '-'} type=${msg.chat.type}`);
            return 'ignored';
        }
        if (typeof msg.text !== 'string' || !msg.text) return 'ignored';
        if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date || msg.sender_chat) { console.log('socialBonus: ignored forwarded / anonymous-admin / sent-as-channel post'); return 'forwarded_or_anonymous'; }
        const { bonuses, keys } = cols(db);
        const key = await keys.findOne({ _id: `msg:${hashMessage(msg.text)}` });
        if (!key) { console.log(`socialBonus: official-group text matches no bonus (user=${msg.from.id}) — edited, or not generated by the app`); return 'no_match'; }
        const fromId = String(msg.from.id);
        if (key.userId !== fromId) { console.log(`socialBonus: sender mismatch (bonus owner=${key.userId}, poster=${fromId})`); return 'sender_mismatch'; } // somebody else pasted this user's message: it proves nothing
        const b = await bonuses.findOne({ _id: key.bonusId });
        if (!b || b.userId !== fromId || b.status !== 'pending') return 'not_pending';
        const sentAt = Number(msg.date) * 1000;
        if (!(sentAt >= b.createdAt.getTime() - 5000) || sentAt > b.expiresAt.getTime()) return 'out_of_window';
        const r = await bonuses.updateOne({ _id: b._id, userId: fromId, status: 'pending', posted: null },
            { $set: { posted: { chatId: msg.chat.id, messageId: msg.message_id, fromId, sentAt: new Date(sentAt), seenAt: new Date() } } });
        console.log(`socialBonus: post ${r.modifiedCount ? 'recorded' : 'already recorded'} bonus=${b._id} user=${fromId}`);
        return r.modifiedCount ? 'recorded' : 'already_recorded';
    } catch (e) { console.error('recordGroupPost failed:', e?.message); return 'error'; }
}

// Wrapper: same behaviour, plus a short diagnostic row for every group post that mentions TON X HUB (or every group post while env
// SOCIAL_BONUS_DEBUG=1) so /api/ops?op=socialBonusDebug can show what the bot really received. No message text is stored.
export async function recordGroupPost(db, msg) {
    const outcome = await evaluateGroupPost(db, msg);
    try {
        if (msg && msg.chat && typeof msg.text === 'string' && (msg.text.includes('TON X HUB') || process.env.SOCIAL_BONUS_DEBUG === '1')) {
            await db.collection('socialBonusSeen').insertOne({
                at: new Date(), purgeAt: new Date(Date.now() + 24 * 3600 * 1000), outcome,
                chatId: msg.chat.id, chatType: msg.chat.type, chatUsername: msg.chat.username || null, fromId: msg.from ? msg.from.id : null,
                anonymousOrChannel: !!msg.sender_chat, forwarded: !!(msg.forward_origin || msg.forward_from || msg.forward_date), textLength: msg.text.length,
                officialGroup: isOfficialGroup(msg.chat),
            });
        }
    } catch (e) { /* diagnostics only */ }
    return outcome;
}

// Admin diagnostic (api/ops.js → op=socialBonusDebug): what the bot saw + latest offers. Nothing secret, no message text.
export async function socialBonusDebug(db) {
    const seen = await db.collection('socialBonusSeen').find({}).sort({ at: -1 }).limit(15).toArray();
    const offers = await db.collection('socialBonuses').find({}).sort({ createdAt: -1 }).limit(5).toArray();
    return {
        expectGroup: process.env.SOCIAL_BONUS_GROUP_ID ? { numericId: String(process.env.SOCIAL_BONUS_GROUP_ID).trim() } : { username: SOCIAL_BONUS_GROUP_USERNAME },
        seenGroupPosts: seen.map(x => ({ at: x.at, outcome: x.outcome, chatId: x.chatId, chatType: x.chatType, chatUsername: x.chatUsername, fromId: x.fromId, anonymousOrChannel: x.anonymousOrChannel, forwarded: x.forwarded, officialGroup: x.officialGroup })),
        latestOffers: offers.map(b => ({ id: b._id, userId: b.userId, status: b.status, opened: !!b.openedAt, postVerified: !!b.posted, createdAt: b.createdAt, messageLength: b.message.length })),
    };
}

// ── 3) API handlers ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadOwn(db, userId, bonusId) {
    if (!isStr(bonusId, 100)) return null;
    return cols(db).bonuses.findOne({ _id: bonusId, userId });
}

export async function handleSocialBonusOpen(req, res, db, userId) {
    const b = await loadOwn(db, userId, req.body?.bonusId);
    if (!b) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (b.status !== 'pending' || Date.now() > b.expiresAt.getTime()) return res.status(200).json({ ok: false, reason: b.status === 'claimed' ? 'already_claimed' : 'expired' });
    if (!b.openedAt) await cols(db).bonuses.updateOne({ _id: b._id, openedAt: null }, { $set: { openedAt: new Date() } });
    return res.status(200).json({ ok: true, bonus: publicBonus({ ...b, openedAt: b.openedAt || new Date() }) });
}

export async function handleSocialBonusDismiss(req, res, db, userId) {
    const b = await loadOwn(db, userId, req.body?.bonusId);
    if (b) await cols(db).bonuses.updateOne({ _id: b._id, userId, status: 'pending', posted: null }, { $set: { status: 'declined', declinedAt: new Date() } });
    return res.status(200).json({ ok: true });
}

export async function handleSocialBonusStatus(req, res, db, userId) {
    const rows = await cols(db).bonuses.find({ userId, status: 'pending', openedAt: { $ne: null }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(1).toArray();
    return res.status(200).json({ ok: true, bonus: rows[0] ? publicBonus(rows[0]) : null });
}

export async function handleSocialBonusClaim(req, res, db, userId, { eligibleFilter }) {
    const { bonuses, rewards } = cols(db);
    const b = await loadOwn(db, userId, req.body?.bonusId);
    if (!b) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (b.status === 'claimed') return res.status(200).json({ ok: false, reason: 'already_claimed' });
    if (b.status !== 'pending') return res.status(200).json({ ok: false, reason: 'not_available' });
    if (Date.now() > b.expiresAt.getTime()) {
        await bonuses.updateOne({ _id: b._id, status: 'pending' }, { $set: { status: 'expired' } });
        return res.status(200).json({ ok: false, reason: 'expired' });
    }
    // The ONLY thing that unlocks the payment: the bot has stored a verified post of THIS message by THIS Telegram user.
    if (!b.posted || b.posted.fromId !== userId) return res.status(200).json({ ok: false, reason: 'not_verified' });

    // once per bonus, ever: the reward row's _id is unique, so parallel / repeated claims cannot pay twice
    const key = `socialbonus:${b._id}`;
    try {
        await rewards.insertOne({
            _id: key, userId, bonusId: b._id, game: b.game, gateId: b.gateId, amount: b.points, messageHash: b.messageHash,
            chatId: b.posted.chatId, messageId: b.posted.messageId, at: new Date(),
        });
    } catch (e) {
        if (!isDup(e)) throw e;
        await bonuses.updateOne({ _id: b._id, status: 'pending' }, { $set: { status: 'claimed', claimedAt: new Date() }, $unset: { purgeAt: '' } });
        return res.status(200).json({ ok: false, reason: 'already_claimed' });
    }
    const paid = await db.collection('users').findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, ...eligibleFilter },
        { $inc: { wtcBalance: b.points, lifetimeWtcEarned: b.points } }, // only ever ADDS to the balance
        { returnDocument: 'after' }
    );
    if (!paid) { await rewards.deleteOne({ _id: key }); return res.status(200).json({ ok: false, reason: 'not_eligible' }); }
    await bonuses.updateOne({ _id: b._id }, { $set: { status: 'claimed', claimedAt: new Date(), rewardTxId: key }, $unset: { purgeAt: '' } });
    return res.status(200).json({ ok: true, reward: b.points, balance: paid.wtcBalance });
}
