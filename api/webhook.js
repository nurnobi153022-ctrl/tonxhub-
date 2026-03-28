export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DB_URL = "https://ton-xhub-default-rtdb.firebaseio.com";

  if (req.method !== "POST") return res.status(200).send("Method Not Allowed");

  const body = req.body;
  console.log("Full Body Received:", JSON.stringify(body)); 

  const chatId = body?.message?.chat?.id;
  const text = body?.message?.text;
  const firstName = body?.message?.from?.first_name || "User";

  if (text && text.startsWith("/start")) {
    console.log("Start command detected for chat:", chatId);

    try {
      // ১. Firebase এ ডাটা সেভ করার চেষ্টা
      const fbRes = await fetch(`${FIREBASE_DB_URL}/users/${chatId}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, first_name: firstName, last_seen: Date.now() })
      });
      console.log("Firebase status:", fbRes.status);

      // ২. টেলিগ্রামে মেসেজ পাঠানোর চেষ্টা
      const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🚀 *Bot is working!*\n\nWelcome ${firstName}. If you see this, your webhook is connected correctly.`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "Open App 🚀", web_app: { url: "https://tonxhub-yu5u.vercel.app" } }]]
          }
        })
      });
      
      const result = await tgRes.json();
      console.log("Telegram API Response:", JSON.stringify(result)); 

    } catch (err) {
      console.error("Critical Error:", err);
    }
  }

  return res.status(200).json({ ok: true });
}
