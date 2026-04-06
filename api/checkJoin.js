export default async function handler(req, res) {
  // ✅ CORS সেটআপ (Mini App এর জন্য)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const TOKEN = process.env.BOT_TOKEN;
  const { userId } = req.query;

  // 🔥 New Channel & Group
  const CHANNEL = "@tonXhub_Earn";   // Official Channel
  const GROUP = "@tonX_hub_chat";    // Community Group

  // ✅ Join Check Function
  async function check(chat) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chat}&user_id=${userId}`
      );
      const data = await response.json();

      if (!data.ok) {
        return false;
      }

      const status = data.result.status;

      return (
        status === "member" ||
        status === "administrator" ||
        status === "creator"
      );

    } catch (e) {
      return false;
    }
  }

  const isChannelJoined = await check(CHANNEL);
  const isGroupJoined = await check(GROUP);

  const allJoined = isChannelJoined && isGroupJoined;

  return res.status(200).json({
    joined: allJoined,
    channel: isChannelJoined,
    group: isGroupJoined
  });
}
