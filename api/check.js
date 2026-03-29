
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const TOKEN = process.env.BOT_TOKEN;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID Required" });
  }

  const CHANNEL = "@tonXhub_Earn";
  const GROUP = "@tonX_hub_chat";

  async function check(chat) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chat}&user_id=${userId}`
      );
      const data = await response.json();

      if (!data.ok) return false;

      const status = data.result.status;
      return (
        status === "member" ||
        status === "administrator" ||
        status === "creator"
      );
    } catch {
      return false;
    }
  }

  const channelJoined = await check(CHANNEL);
  const groupJoined = await check(GROUP);

  // 🔥 Save to Firebase
  await fetch(
    `https://tonxhub-default-rtdb.firebaseio.com/users/${userId}.json`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelJoined,
        groupJoined,
        lastChecked: Date.now(),
      }),
    }
  );

  return res.status(200).json({
    channel: channelJoined,
    group: groupJoined,
  });
}
