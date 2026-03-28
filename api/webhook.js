export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_URL = "https://ton-xhub-default-rtdb.firebaseio.com";

  if (req.method !== "POST") {
    return res.status(200).send("Bot is active!");
  }

  try {
    const body = req.body;
    const message = body?.message;
    const chatId = message?.chat?.id;
    const text = message?.text;
    const firstName = message?.from?.first_name || "User";

    if (!chatId || !text) return res.status(200).json({ ok: true });

    if (text.startsWith("/start")) {
      // ১. Firebase এ ডাটা সেভ
      await fetch(`${FIREBASE_URL}/users/${chatId}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          first_name: firstName,
          last_seen: Date.now()
        })
      });

      // ২. টেলিগ্রামে বাটনসহ মেসেজ পাঠানো
      const welcomeMsg = `🚀 *Welcome to TONX HUB EARN BOT*\n\nHello ${firstName}! Click the button below to start earning TON coins.`;
      
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: welcomeMsg,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open Mini App", web_app: { url: "https://tonxhub-yu5u.vercel.app" } }],
              [{ text: "🎁 Invite Link", url: `https://t.me/tonxhubEarn_bot?start=${chatId}` }],
              [{ text: "📢 Official Channel", url: "https://t.me/tonXhub_Earn" }],
              [{ text: "👥 Community Group", url: "https://t.me/tonX_hub_chat" }]
            ]
          }
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook Error:", error.message);
    return res.status(200).json({ ok: true }); // টেলিগ্রামকে ২০০ পাঠাতে হয় যাতে সে বারবার একই মেসেজ না পাঠায়
  }
}
