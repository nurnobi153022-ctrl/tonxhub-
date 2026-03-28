export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  // শুধু POST রিকোয়েস্ট গ্রহণ করবে
  if (req.method !== "POST") {
    return res.status(200).send("Bot server is running!");
  }

  const body = req.body;
  const message = body?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  const firstName = message?.from?.first_name || "User";

  // যদি চ্যাট আইডি বা টেক্সট না থাকে তবে রিটার্ন করবে
  if (!chatId || !text) {
    return res.status(200).json({ ok: true });
  }

  // যদি ইউজার /start দেয়
  if (text.startsWith("/start")) {
    
    const telegramUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

    const payload = {
      chat_id: chatId,
      text: `🚀 *Welcome to TONX HUB EARN BOT*\n\nHello ${firstName}! Click the buttons below 👇`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: "🎁 Invite Link", 
              url: `https://t.me/tonxhubEarn_bot?start=${chatId}` 
            }
          ],
          [
            { 
              text: "📢 Official Channel", 
              url: "https://t.me/tonXhub_Earn" 
            }
          ],
          [
            { 
              text: "👥 Community Group", 
              url: "https://t.me/tonX_hub_chat" 
            }
          ]
        ]
      }
    };

    try {
      await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.error("Error sending message:", e);
    }
  }

  return res.status(200).json({ ok: true });
}
