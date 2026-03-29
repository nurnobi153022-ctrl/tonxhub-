export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body;
  const chatId = body.message?.chat?.id;
  const text = body.message?.text;

  if (!chatId) {
    return res.status(200).json({ ok: true });
  }

  if (text === "/start") {

    // 🔥 Save user in Firebase Realtime Database
    await fetch(
      "https://ton-xhub-default-rtdb.firebaseio.com/users/" +
        chatId +
        ".json",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          joinedAt: Date.now(),
        }),
      }
    );

    // ✅ Send Welcome Message with Buttons
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚀 Welcome to TONX HUB EARN BOT

Earn and grow with us 💎

Choose an option below:`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎁 Invite Link",
                url: `https://t.me/tonxhubEarn_bot?start=${chatId}`,
              },
            ],
            [
              {
                text: "📢 Official Channel",
                url: "https://t.me/tonXhub_Earn",
              },
            ],
            [
              {
                text: "👥 Community Group",
                url: "https://t.me/tonX_hub_chat",
              },
            ],
          ],
        },
      }),
    });
  }

  return res.status(200).json({ ok: true });
}
