export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DB_URL = "https://ton-xhub-default-rtdb.firebaseio.com";

  // শুধু POST রিকোয়েস্ট হ্যান্ডেল করবে
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body;
  
  // বডি চেক করা (ডিবাগিং এর জন্য)
  console.log("Update Received:", JSON.stringify(body));

  const message = body?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  const firstName = message?.from?.first_name || "User";

  if (!chatId) {
    return res.status(200).json({ ok: true });
  }

  // যদি টেক্সট /start দিয়ে শুরু হয় (রেফারেল থাকলেও কাজ করবে)
  if (text && text.startsWith("/start")) {
    
    try {
      // ১. Firebase-এ ডাটা সেভ করা
      await fetch(`${FIREBASE_DB_URL}/users/${chatId}.json`, {
        method: "PATCH", // PUT এর বদলে PATCH দিলে ডাটা ওভাররাইট হবে না, শুধু আপডেট হবে
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          first_name: firstName,
          last_seen: Date.now()
        })
      });

      // ২. টেলিগ্রামে রিপ্লাই পাঠানো
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🚀 *Welcome to TONX HUB EARN BOT*\n\nHello ${firstName}! Start earning TON coins by watching ads and inviting friends.`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🚀 Open App",
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
                  text: "📢 Channel",
                  url: "https://t.me/tonXhub_Earn"
                },
                {
                  text: "👥 Group",
                  url: "https://t.me/tonX_hub_chat"
                }
              ]
            ]
          }
        })
      });
    } catch (error) {
      console.error("Error:", error);
    }
  }

  return res.status(200).json({ ok: true });
}
