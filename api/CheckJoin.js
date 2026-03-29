export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const TOKEN = process.env.BOT_TOKEN; // নিশ্চিত করুন যে এটি আপনার হোস্টিংয়ে সেভ করা আছে
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID Missing" });
  }

  if (!TOKEN) {
    return res.status(500).json({ error: "Bot Token Not Found in Environment Variables" });
  }

  const CHANNEL = "@tonXhub_Earn";
  const GROUP = "@tonX_hub_chat";

  async function check(chat) {
    try {
      const url = `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chat}&user_id=${userId}`;
      const response = await fetch(url);
      const data = await response.json();

      if (!data.ok) {
        console.error(`Telegram Error for ${chat}:`, data.description);
        return { status: false, error: data.description };
      }

      const status = data.result.status;
      // Member, administrator, or creator হলে সে জয়েন করেছে ধরা হবে
      const isMember = ["member", "administrator", "creator"].includes(status);
      return { status: isMember, error: null };
    } catch (e) {
      return { status: false, error: e.message };
    }
  }

  try {
    const channelData = await check(CHANNEL);
    const groupData = await check(GROUP);

    // Firebase-এ লগ সেভ করা (Optional, যদি Firebase কাজ না করে তবে এটি API-কে স্লো করতে পারে)
    // Firebase URL এবং Rules চেক করুন
    try {
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
    } catch (firebaseErr) {
      console.error("Firebase Log Error:", firebaseErr.message);
    }

    return res.status(200).json({
      channel: channelData.status,
      group: groupData.status,
      channelError: channelData.error,
      groupError: groupData.error,
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
}
