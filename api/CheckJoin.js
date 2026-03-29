export default async function handler(req, res) {
  // ✅ CORS Headers
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const TOKEN = process.env.BOT_TOKEN;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID Missing" });
  }

  // ✅ TonX Hub Channel & Group
  const CHANNEL = "@tonXhub_Earn";
  const GROUP = "@tonX_hub_chat";

  // 🔍 Check Membership Function
  async function check(chat) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chat}&user_id=${userId}`
      );

      const data = await response.json();

      if (!data.ok) {
        return { status: false, error: data.description };
      }

      const status = data.result.status;
      const isMember =
        status === "member" ||
        status === "administrator" ||
        status === "creator";

      return { status: isMember, error: null };
    } catch (e) {
      return { status: false, error: e.message };
    }
  }

  const channelData = await check(CHANNEL);
  const groupData = await check(GROUP);

  // 🔥 Save Check Log in Firebase
  await fetch(
    `https://ton-xhub-default-rtdb.firebaseio.com/checkLogs/${userId}.json`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        channel: channelData.status,
        group: groupData.status,
        checkedAt: Date.now(),
      }),
    }
  );

  return res.status(200).json({
    channel: channelData.status,
    group: groupData.status,
    channelError: channelData.error,
    groupError: groupData.error,
  });
}
