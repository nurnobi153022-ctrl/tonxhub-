export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const TOKEN = process.env.BOT_TOKEN; 
  const { userId } = req.query;

  if (!userId) return res.status(400).json({ error: "User ID Missing" });
  if (!TOKEN) return res.status(500).json({ error: "Bot Token Missing in Vercel" });

  const CHANNEL = "@tonXhub_Earn";
  const GROUP = "@tonX_hub_chat";

  async function check(chat) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chat}&user_id=${userId}`
      );
      const data = await response.json();
      if (!data.ok) return { status: false };
      
      const status = data.result.status;
      const isMember = ["member", "administrator", "creator"].includes(status);
      return { status: isMember };
    } catch (e) {
      return { status: false };
    }
  }

  const channelData = await check(CHANNEL);
  const groupData = await check(GROUP);

  return res.status(200).json({
    channel: channelData.status,
    group: groupData.status
  });
}
