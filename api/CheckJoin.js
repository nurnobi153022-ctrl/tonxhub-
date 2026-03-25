export default async function handler(req, res) {
  // CORS Headers for Web App
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const TOKEN = process.env.BOT_TOKEN;
  const { userId } = req.query;

  const CHANNEL = "@tonXhub_Earn";
  const GROUP = "@tonX_hub_chat";

  async function check(chat) {
    try {
        const response = await fetch(
          `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${chat}&user_id=${userId}`
        );
        const data = await response.json();

        // যদি টেলিগ্রাম এরর দেয়, তাহলে সেই এরর মেসেজটি রিটার্ন করবে
        if (!data.ok) {
            return { status: false, error: data.description };
        }

        const status = data.result.status;
        const isMember = status === "member" || status === "administrator" || status === "creator";
        return { status: isMember, error: null };
        
    } catch (e) {
        return { status: false, error: e.message };
    }
  }

  const channelData = await check(CHANNEL);
  const groupData = await check(GROUP);

  return res.status(200).json({
    channel: channelData.status,
    group: groupData.status,
    channelError: channelData.error,
    groupError: groupData.error
  });
}
