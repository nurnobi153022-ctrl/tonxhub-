// lib/telegram.js
//
// সব জায়গায় (checkJoin, taskComplete, withdraw notification, admin bot)
// বারবার একই fetch কোড না লিখে এই helper গুলো শেয়ার করা হচ্ছে।

const BOT_TOKEN = process.env.BOT_TOKEN;

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 🚦 OUTBOUND TELEGRAM BOT API RATE LIMITER
// Telegram's limits: ≈1 message/second per private chat (short bursts OK), ≤20 messages/minute per group/channel,
// ≈30 messages/second for the whole bot. Past them Telegram answers HTTP 429 with parameters.retry_after.
// Every tgApi() call now goes through this limiter:
//   1) Pacing   — a token bucket per chat + one for the whole bot (RAM, per warm serverless instance).
//                 A call that is too early waits a moment (never more than TG_MAX_WAIT_MS) instead of being rejected.
//   2) 429 care — when Telegram still says 429, the chat (or, if several chats hit it together, the whole bot) is
//                 paused for retry_after. A short pause is waited out and the call retried ONCE; a long pause makes
//                 the call return a 429 result immediately WITHOUT hitting Telegram, so a flood can't dig deeper.
// The return shape never changes: {ok:false, error_code:429, parameters:{retry_after}} — callers that already
// check `error_code === 429` (e.g. lib/broadcastProcessor.js) keep working. answerCallbackQuery is never delayed
// (the answer is useless if late). Buckets live in RAM, so this limit is per warm instance — together with
// Telegram's own 429 answer that is enough in practice; it is not a global (cross-instance) counter.
// Tunable via env: TG_GLOBAL_PER_SEC, TG_CHAT_BURST, TG_GROUP_PER_MIN, TG_MAX_WAIT_MS, TG_RETRY_MAX_MS.
// ═══════════════════════════════════════════════════════════════════════════════════════════
const tgNum = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v > 0 ? v : def; };
export const TG_LIMITS = {
    GLOBAL_PER_SEC: tgNum('TG_GLOBAL_PER_SEC', 25),    // whole bot, messages per second (Telegram: ~30)
    CHAT_BURST:     tgNum('TG_CHAT_BURST', 3),         // private chat: this many at once, then 1 per second
    GROUP_PER_MIN:  tgNum('TG_GROUP_PER_MIN', 18),     // group / channel: per minute (Telegram: 20)
    MAX_WAIT_MS:    tgNum('TG_MAX_WAIT_MS', 2500),     // never delay one call longer than this for pacing
    RETRY_MAX_MS:   tgNum('TG_RETRY_MAX_MS', 4000),    // a 429 pause up to this long is waited out + retried once
};
// methods that deliver / change a chat's content and are counted by Telegram's per-chat limits
const TG_PACED_METHODS = new Set([
    'sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAnimation', 'sendSticker', 'sendMediaGroup',
    'editMessageText', 'editMessageCaption', 'editMessageReplyMarkup', 'deleteMessage', 'forwardMessage', 'copyMessage',
]);
const tgSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tgBuckets = new Map();        // "g" | "c:<chatId>" -> { tokens, t }
const tgChatPause = new Map();      // chatId -> pausedUntil (ms)
let tgGlobalPauseUntil = 0;
let tgRecent429 = [];               // [{ t, key }] — to tell "one noisy chat" from "the whole bot is limited"
const TG_MAX_KEYS = 5000;

// Reserve one token; returns how long the caller must wait (ms) for it to be available.
function tgTake(key, capacity, refillPerMs, now) {
    let b = tgBuckets.get(key);
    if (!b) {
        if (tgBuckets.size >= TG_MAX_KEYS) { for (const [k, v] of tgBuckets) { if (now - v.t > 120000) tgBuckets.delete(k); } if (tgBuckets.size >= TG_MAX_KEYS) tgBuckets.clear(); }
        b = { tokens: capacity, t: now }; tgBuckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + (now - b.t) * refillPerMs);
    b.t = now;
    b.tokens = Math.max(b.tokens - 1, -capacity);   // debt is capped, so the wait is bounded too
    return b.tokens >= 0 ? 0 : Math.ceil(-b.tokens / refillPerMs);
}

function tgLocal429(retryAfterSec) {
    return { ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfterSec} (local rate limiter)`, parameters: { retry_after: retryAfterSec }, local: true };
}

// Returns null when the call may go ahead (after any needed wait), or a synthetic 429 result when it must not.
async function tgThrottle(chatKey) {
    const now = Date.now();
    const pauseUntil = Math.max(tgGlobalPauseUntil, tgChatPause.get(chatKey) || 0);
    if (pauseUntil > now) {
        const left = pauseUntil - now;
        if (left > TG_LIMITS.RETRY_MAX_MS) return tgLocal429(Math.ceil(left / 1000));
        await tgSleep(left);
    }
    const t = Date.now();
    const isGroup = String(chatKey).startsWith('-');
    const chatWait = isGroup
        ? tgTake(`c:${chatKey}`, TG_LIMITS.GROUP_PER_MIN, TG_LIMITS.GROUP_PER_MIN / 60000, t)
        : tgTake(`c:${chatKey}`, TG_LIMITS.CHAT_BURST, 1 / 1000, t);
    const globalWait = tgTake('g', TG_LIMITS.GLOBAL_PER_SEC, TG_LIMITS.GLOBAL_PER_SEC / 1000, t);
    const wait = Math.min(Math.max(chatWait, globalWait), TG_LIMITS.MAX_WAIT_MS);
    if (wait > 0) await tgSleep(wait);
    return null;
}

function tgNote429(chatKey, retryAfterSec) {
    const now = Date.now(), until = now + retryAfterSec * 1000;
    if (chatKey) {
        if (tgChatPause.size >= TG_MAX_KEYS) { for (const [k, v] of tgChatPause) { if (v < now) tgChatPause.delete(k); } if (tgChatPause.size >= TG_MAX_KEYS) tgChatPause.clear(); }
        tgChatPause.set(chatKey, Math.max(tgChatPause.get(chatKey) || 0, until));
    }
    tgRecent429 = tgRecent429.filter((x) => now - x.t < 10000);
    tgRecent429.push({ t: now, key: chatKey });
    // 3+ different chats limited within 10 s → it is the bot as a whole, not one chat: pause everything.
    if (new Set(tgRecent429.map((x) => x.key)).size >= 3) tgGlobalPauseUntil = Math.max(tgGlobalPauseUntil, until);
}

async function tgRawCall(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

export async function tgApi(method, body) {
    const chatKey = body && body.chat_id != null ? String(body.chat_id) : null;
    if (chatKey && TG_PACED_METHODS.has(method)) {
        const blocked = await tgThrottle(chatKey);
        if (blocked) return blocked;
    }
    let r = await tgRawCall(method, body);
    if (r && r.ok === false && r.error_code === 429 && method !== 'answerCallbackQuery') {
        const retryAfter = Math.max(1, Number(r.parameters?.retry_after) || 1);
        tgNote429(chatKey, retryAfter);
        if (retryAfter * 1000 <= TG_LIMITS.RETRY_MAX_MS) {
            await tgSleep(retryAfter * 1000 + 100);
            r = await tgRawCall(method, body);   // ONE retry — if it is still 429 the caller gets that 429
        }
    }
    return r;
}

// User-supplied text (wallet address, username, etc.) must be escaped before it
// goes into a parse_mode:'HTML' message. Without this, a stray "<" makes Telegram
// reject the whole message (the admin never sees the request) or lets the user
// inject their own formatting/links.
export function escHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const tgSend = (chatId, text, extra = {}) =>
    tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const tgEdit = (chatId, messageId, text, extra = {}) =>
    tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

// Telegram rejects editMessageText on a message that was sent as a
// photo (sendPhoto) with "Bad Request: there is no text in the message to
// edit". Photo messages only have a CAPTION, so they need editMessageCaption
// instead. tgApi() doesn't throw on a Telegram-side {ok:false} error (only
// on a network failure), so calling tgEdit on a photo message fails
// completely silently — the caller sees no exception, the message just
// never changes. Use this whenever the message being edited was sent via
// tgSendPhoto (see the bc_confirm handler in api/bot.js for the bug this fixed).
export const tgEditCaption = (chatId, messageId, caption, extra = {}) =>
    tgApi('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML', ...extra });

export const tgSendPhoto = (chatId, photo, caption, extra = {}) =>
    tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });

export const tgAnswerCallback = (callbackQueryId, text = '', showAlert = false) =>
    tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });

// userId-কে CHANNEL/GROUP-এ মেম্বার কিনা চেক করে
//
// this used to fail-safe to `false` on the very first API hiccup
// (rate limit, timeout, transient 5xx from Telegram). checkJoin calls this
// twice (channel + group) and gets called a LOT — the 60s background
// watcher, every manual "I've joined, check now" tap, and the initial
// gate check — so any single Telegram API blip flashed "not joined" at a
// genuinely-joined user. That's the "checkJoin poriborton hoy, kono karon
// chara fail hoy" pattern being reported. Now a single transient failure
// (not-ok response OR thrown error) gets ONE short retry before giving up;
// a real "not a member" status (r.ok true, status genuinely not in the
// list) is trusted immediately on the first try — no need to retry a
// definitive answer.
async function getChatMemberStatus(userId, chatUsername) {
    try {
        const r = await tgApi('getChatMember', { chat_id: chatUsername, user_id: userId });
        if (!r.ok) {
            // Telegram-এর আসল error message log করছি — bot admin থাকলেও fail হলে এখানেই কারণ দেখা যাবে
            // (যেমন: bot ওই chat-এ নেই, username ভুল, ইত্যাদি)
            console.error(`isMember(${userId}, ${chatUsername}) failed:`, r.description);
            return { ok: false };
        }
        return { ok: true, status: r.result?.status };
    } catch (err) {
        console.error(`isMember(${userId}, ${chatUsername}) threw:`, err.message);
        return { ok: false };
    }
}

export async function isMember(userId, chatUsername) {
    let result = await getChatMemberStatus(userId, chatUsername);
    if (!result.ok) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // brief backoff before the one retry
        result = await getChatMemberStatus(userId, chatUsername);
    }
    if (!result.ok) return false; // still failing after retry — fail-safe as before, but now only after two tries
    return ['member', 'administrator', 'creator'].includes(result.status);
}

// আপনার main.html-এ পাওয়া official channel/community
// Join links shown to users (private invite links).
export const OFFICIAL_CHANNEL_URL = 'https://t.me/+7N5N7UhsywBlZjk1';
export const COMMUNITY_GROUP_URL = 'https://t.me/+XxnuiIa6pec1N2Zl';
// ⚠️ Membership check (getChatMember) cannot use invite links — it needs the chat's numeric ID
// (e.g. -1001234567890) and the bot must be an admin there. These are the NEW chat IDs (bot must be admin in both).
// Optionally override via Vercel env vars OFFICIAL_CHANNEL_ID / COMMUNITY_GROUP_ID.
export const OFFICIAL_CHANNEL = process.env.OFFICIAL_CHANNEL_ID || '-1004392278890';
export const COMMUNITY_GROUP = process.env.COMMUNITY_GROUP_ID || '-1004319296054';
// Payment proof group — also REQUIRED to use the app (same join-gate as channel + community).
// Public group, so membership can be checked by @username; the bot must be a member/admin of it
// (an admin is safest). Optionally override the check target via env PAYMENT_PROOF_GROUP_ID (numeric id).
export const PAYMENT_PROOF_GROUP_URL = 'https://t.me/tonxhub_paymentproof';
export const PAYMENT_PROOF_GROUP = process.env.PAYMENT_PROOF_GROUP_ID || '-1004367961060';
// this was pointing at the OLD shared "fruit_cut_payment" channel.
// The post-on-approve code below (api/bot.js wd_approve_) was working fine —
// the bot IS an admin of that old channel too, so it posted successfully
// every time, just to the wrong (old/shared) channel, which is why nothing
// ever showed up in the new TON X HUB payment proof channel and it
// looked like posting had silently stopped. Now pointed at the real one.
export const PAYMENT_CHANNEL = PAYMENT_PROOF_GROUP; // TON X HUB payment group — approved payouts are auto-posted here
// fixed proof-of-payment banner posted with every approved withdrawal
// (see api/bot.js wd_approve_). Swap this URL if you want a different image later.
export const PAYMENT_PROOF_PHOTO = 'https://cdn.phototourl.com/free/2026-08-07-562ff309-be9d-4683-974d-e5a27da44e18.png';
