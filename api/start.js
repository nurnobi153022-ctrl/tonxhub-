export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  // শুধুমাত্র POST রিকোয়েস্ট গ্রহণ করবে
  if (req.method !== "POST") {
    return res.status(200).send("TonX Hub Bot Server is Active!");
  }

  try {
    const body = req.body;
    const message = body?.message;
    const chatId = message?.chat?.id;
    const text = message?.text;
    const firstName = message?.from?.first_name || "User";

    // যদি চ্যাট আইডি বা টেক্সট না থাকে তবে রিটার্ন করবে
    if (!chatId || !text) {
      return res.status(200).json({ ok: true });
    }

    // যদি ইউজার /start দেয় (রেফারেল কোড থাকলেও কাজ করবে)
    if (text.startsWith("/start")) {
      
      const telegramUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

      const payload = {
        chat_id: chatId,
        text: `🚀 *Welcome to TONX HUB EARN BOT*\n\nHello ${firstName}! Click the buttons below to start earning TON coins.`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: "🚀 Open Mini App", 
                web_app: { url: "https://tonxhub-yu5u.vercel.app" } 
              }
            ],
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
              },
              { 
                text: "👥 Community Group", 
                url: "https://t.me/tonX_hub_chat" 
              }
            ]
          ]
        }
      };

      // টেলিগ্রামে মেসেজ পাঠানো
      await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Error:", error);
    return res.status(200).json({ ok: true });
  }
}
