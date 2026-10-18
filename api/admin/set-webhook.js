// api/admin/set-webhook.js — NEW
//
// নতুন প্রজেক্ট / নতুন Vercel ডোমেইনের জন্য Telegram webhook রেজিস্টার করে।
// setup-indexes.js এর মতোই: ব্রাউজারে একটা URL খুলে GET request পাঠালেই কাজ হয়।
//
// ব্যবহার (deploy হওয়ার পর, মোবাইল Chrome এ):
//   https://tonxhub.vercel.app/api/admin/set-webhook?secret=<BOT_TOKEN>
//
// অতিরিক্ত অপশন:
//   &drop=1   → পুরনো জমে থাকা pending update ফেলে দেয় (নতুন বটে পুরনো মেসেজ আসবে না)
//   &info=1   → শুধু বর্তমান webhook এর অবস্থা দেখায়, কিছু বদলায় না
//   &delete=1 → webhook মুছে দেয়
//
// ⚠️ আগে Vercel env এ এই দুটো সেট থাকতে হবে (তারপর Redeploy):
//   BOT_TOKEN                  — নতুন বটের টোকেন
//   TELEGRAM_WEBHOOK_SECRET    — যেকোনো লম্বা random string (শুধু A-Z a-z 0-9 _ -, ১-২৫৬ অক্ষর)
// api/bot.js এই secret না মিললে সব রিকোয়েস্ট 401 দিয়ে ফেরত দেয়, তাই
// setWebhook এ একই secret পাঠানো হয়।
//
// SECURITY: setup-indexes.js এর মতো BOT_TOKEN-ই shared-secret। ভুল/অনুপস্থিত হলে 401।
// bot.js শুধু message আর callback_query ব্যবহার করে, তাই allowed_updates সেটাই।

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// নতুন Vercel ডোমেইন বদলালে শুধু এই লাইনটা বদলান
const APP_URL = 'https://tonxhub.vercel.app';
const WEBHOOK_URL = `${APP_URL}/api/bot`;

async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return r.json();
}

// token ফাঁস না হয় এজন্য রেসপন্স থেকে সরিয়ে দেওয়া
const safeInfo = (info) => {
    const r = info?.result || {};
    return {
        url: r.url,
        pending_update_count: r.pending_update_count,
        last_error_date: r.last_error_date,
        last_error_message: r.last_error_message,
        allowed_updates: r.allowed_updates,
    };
};

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    try {
        if (req.query.info === '1') {
            return res.status(200).json({ ok: true, webhook: safeInfo(await tg('getWebhookInfo')) });
        }

        if (req.query.delete === '1') {
            const del = await tg('deleteWebhook', { drop_pending_updates: req.query.drop === '1' });
            return res.status(200).json({ ok: !!del.ok, deleted: del });
        }

        if (!WEBHOOK_SECRET) {
            return res.status(500).json({
                ok: false,
                error: 'TELEGRAM_WEBHOOK_SECRET Vercel env এ সেট করা নেই। সেট করে Redeploy করুন, তারপর আবার খুলুন।',
            });
        }
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
            return res.status(500).json({
                ok: false,
                error: 'TELEGRAM_WEBHOOK_SECRET এ শুধু A-Z a-z 0-9 _ - ব্যবহার করা যাবে (১-২৫৬ অক্ষর)।',
            });
        }

        const set = await tg('setWebhook', {
            url: WEBHOOK_URL,
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: req.query.drop === '1',
            max_connections: 40,
        });

        const info = await tg('getWebhookInfo');
        return res.status(set.ok ? 200 : 502).json({
            ok: !!set.ok,
            setWebhook: set,
            webhook: safeInfo(info),
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || 'failed' });
    }
}
