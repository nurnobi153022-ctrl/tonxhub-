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

    // 👉 Dynamic Refer Link
    const referLink = `https://t.me/tonXhubEarn_bot/TonXHub?startapp=${chatId}`;

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "🚀 Welcome to TONX HUB\n\nJoin our official channels & invite friends to earn:",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📢 Official Channel",
                url: "https://t.me/tonXhub_Earn"
              }
            ],
            [
              {
                text: "💬 Community Group",
                url: "https://t.me/tonX_hub_chat"
              }
            ],
            [
              {
                text: "🎁 Invite & Earn",
                url: referLink
              }
            ]
          ]
        }
      })
    });

  }

  return res.status(200).json({ ok: true });
}
