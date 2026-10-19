// ─────────────────────────────────────────────────────────────────────────────
// api/user.js — replace the WHOLE existing `handleCheckJoin` function with this.
// (Your zip's api/user.js was cut off in the middle of this function, so the
//  rest of the file could not be shipped. Only this function changed.)
//
// What changed:
//  • Payment Proof group is NOT checked (channel + community only).
//  • Response now also carries `channel` and `group` booleans, so the new gate
//    can show exactly which place is still missing. Old fields are unchanged.
// Imports: you can drop PAYMENT_PROOF_GROUP from the telegram.js import line.
// ─────────────────────────────────────────────────────────────────────────────
async function handleCheckJoin(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ joined: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(userId, OFFICIAL_CHANNEL),
            isMember(userId, COMMUNITY_GROUP),
        ]);
        const joined = inChannel && inGroup;
        let leftAfterVerifying = false;

        try {
            if (joined) {
                await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: true } });
                await maybeAwardReferralMilestones(db, userId, { channelVerified: true });
            } else {
                // Was verified before but is missing now → show the "you left" wording.
                const u = await db.collection('users').findOne({ _id: userId }, { projection: { channelVerified: 1 } });
                if (u?.channelVerified) {
                    leftAfterVerifying = true;
                    await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: false } });
                }
            }
        } catch { /* non-blocking: membership answer below is still correct */ }

        return res.status(200).json({ joined, channel: inChannel, group: inGroup, leftAfterVerifying });
    } catch (err) {
        console.error('checkJoin error:', err);
        return res.status(500).json({ joined: false, error: 'check_failed' });
    }
}
