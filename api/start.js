export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body;
  const chatId = body.message?.chat?.id;
  const text = body.message?.text;
  const user = body.message?.from;

  if (!chatId) {
    return res.status(200).json({ ok: true });
  }

  if (text === "/start" || text?.startsWith("/start ")) {

    // Save user to Firebase Realtime Database
    try {
      await fetch(
        `https://ton-xhub-default-rtdb.firebaseio.com/users/${chatId}.json`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            username: user?.username || "N/A",
            first_name: user?.first_name || "",
            joinedAt: Date.now(),
          }),
        }
      );
    } catch (e) {
      console.error("Firebase save failed:", e);
    }

    // Send Welcome Message
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        parse_mode: "HTML",
        text: `ðŸš€ <b>Welcome to TON X HUB!</b>

ðŸ’Ž Earn TON by doing simple daily tasks!

âœ… Watch Ads â€” earn Points daily
ðŸŽ¡ Spin Lucky Wheel â€” every day
ðŸ“‹ Complete Tasks â€” bonus rewards  
ðŸ‘¥ Invite Friends â€” get 400 Pts each
ðŸ’¸ Withdraw â€” convert Points to <b>TON</b> coin

âš ï¸ <b>You must join our Channel and Group to unlock earning features!</b>

ðŸ‘‡ Open the app and verify your account:`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "ðŸŽ Invite Link",
                url: `https://t.me/tonxhubEarn_bot?start=${chatId}`,
              },
            ],
            [
              {
                text: "ðŸ“¢ Official Channel",
                url: "https://t.me/tonXhub_Earn",
              },
            ],
            [
              {
                text: "ðŸ‘¥ Community Group",
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
