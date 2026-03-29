export default async function handler(req, res) {
  // CORS Headers - এটি অন্য ডোমেইন থেকে রিকোয়েস্ট এক্সেপ্ট করতে সাহায্য করবে
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");

  if (req.method === "OPTIONS") return res.status(200).end();

  const TOKEN = process.env.BOT_TOKEN; 
  const { userId } = req.query;

  if (!userId) return res.status(400).json({ success: false, error: "User ID Missing" });
  if (!TOKEN) return res.status(500).json({ success: false, error: "Bot Token Missing in Vercel" });

  const CHANNEL = "@tonXhub_Earn";
  const GROUP = "@tonX_hub_chat";

  async function check(chatId) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chatId}&user_id=${userId}`);
      const data = await response.json();
      if (data.ok) {
        const status = data.result.status;
        return ["member", "administrator", "creator"].includes(status);
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  try {
    const isChannel = await check(CHANNEL);
    const isGroup = await check(GROUP);

    return res.status(200).json({
      success: true,
      isJoined: isChannel && isGroup,
      channel: isChannel,
      group: isGroup
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "API Error" });
  }
}
