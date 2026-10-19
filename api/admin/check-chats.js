// api/admin/check-chats.js — NEW (diagnostic)
//
// "সব চ্যানেলে জয়েন আছে তবুও জয়েন নেই দেখায়" সমস্যার কারণ খুঁজে বের করে।
// কোড যে চ্যানেল/গ্রুপ ID গুলো দিয়ে চেক করে, সেগুলোর প্রতিটার জন্য দেখায়:
//   - চ্যাটটা Telegram এ আছে কিনা (নাম কী)
//   - বট ওই চ্যাটে অ্যাডমিন কিনা
//   - তোমার (user) স্ট্যাটাস কী
//
// ব্যবহার:
//   https://tonxhub.vercel.app/api/admin/check-chats?secret=<BOT_TOKEN>&user=<তোমার Telegram ID>

import { OFFICIAL_CHANNEL, COMMUNITY_GROUP, PAYMENT_PROOF_GROUP } from '../../lib/telegram.js';

const BOT_TOKEN = process.env.BOT_TOKEN;

async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return r.json();
}

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
        const me = await tg('getMe');
        const botId = me?.result?.id;
        const userId = req.query.user ? Number(req.query.user) : null;

        const targets = {
            OFFICIAL_CHANNEL,
            COMMUNITY_GROUP,
            PAYMENT_PROOF_GROUP,
        };

        const out = {};
        for (const [label, chatId] of Object.entries(targets)) {
            const chat = await tg('getChat', { chat_id: chatId });
            const botMember = botId ? await tg('getChatMember', { chat_id: chatId, user_id: botId }) : null;
            const userMember = userId ? await tg('getChatMember', { chat_id: chatId, user_id: userId }) : null;
            out[label] = {
                checked_id: chatId,
                chat: chat.ok ? { title: chat.result.title, type: chat.result.type } : { error: chat.description },
                bot_status: botMember ? (botMember.ok ? botMember.result.status : { error: botMember.description }) : 'n/a',
                user_status: userMember ? (userMember.ok ? userMember.result.status : { error: userMember.description }) : 'pass &user=<id>',
            };
        }
        return res.status(200).json({ ok: true, bot: me?.result?.username, chats: out });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || 'failed' });
    }
}
