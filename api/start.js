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

  if (text === "/start" || text?.startsWith("/start ")) {

    // Save user to Firebase
    try {
      await fetch(
        `https://ton-xhub-default-rtdb.firebaseio.com/users/${chatId}.json`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            joinedAt: Date.now(),
          }),
        }
      );
    } catch (e) {}

    // Send welcome message — NO parse_mode to avoid emoji breaking
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          "🚀 Welcome to TON X HUB!\n\n" +
          "💎 Earn TON by doing simple daily tasks!\n\n" +
          "✅ Watch Ads — earn Points daily\n" +
          "🎡 Spin Lucky Wheel — every day\n" +
          "📋 Complete Tasks — bonus rewards\n" +
          "👥 Invite Friends — get 400 Pts each\n" +
          "💸 Withdraw — convert Points to TON coin\n\n" +
          "⚠️ You must join our Official Channel & Community Group to unlock all earning features!\n\n" +
          "👇 Join below, then open the app and verify:",
        reply_markup: {
          inline_keyboard: [
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
            [
              {
                text: "🎁 My Invite Link",
                url: `https://t.me/tonxhubEarn_bot?start=${chatId}`,
              },
            ],
          ],
        },
      }),
    });
  }

  return res.status(200).json({ ok: true });
}
