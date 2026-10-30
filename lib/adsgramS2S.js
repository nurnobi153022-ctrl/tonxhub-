// lib/adsgramS2S.js — Adsgram SERVER-TO-SERVER ("Reward URL") confirmation.
//
// HOW IT WORKS
//   1. In partner.adsgram.ai you set, per block, a Reward URL:
//        Task block   → https://<your-domain>/api/adsgram/reward?userid=[userId]&block=task&secret=<ADSGRAM_S2S_SECRET>
//        Reward block → https://<your-domain>/api/adsgram/reward?userid=[userId]&block=reward&secret=<ADSGRAM_S2S_SECRET>
//      Adsgram replaces [userId] with the Telegram id and calls the URL (HTTPS GET) when the ad was completed.
//   2. handleAdsgramReward() (below) stores ONE "verified ad" row per call in collection `adsgramS2S`.
//   3. Your existing claim endpoints (Ad Missions claim, Mini Bot gate, Arrow Puzzle gate) call
//      consumeAdsgramS2S(); it atomically spends one such row. No row → no reward.
//
// SAFE ROLLOUT: nothing changes until the env var ADSGRAM_S2S_REQUIRED=1 is set. While it is unset every
// claim behaves exactly as before. Set it only AFTER the Reward URLs are saved in Adsgram and tested.
//
// Interstitial blocks (e.g. the "init" ad int-27941) have NO reward → Adsgram sends no callback → they can
// never be S2S-verified. That is expected: the init ad pays nothing, so there is nothing to verify.
//
// Env: ADSGRAM_S2S_SECRET (long random string, required), ADSGRAM_S2S_REQUIRED=1 (turn enforcement on).

import crypto from 'crypto';
import { connectToDatabase } from './mongodb.js';

const BLOCKS = new Set(['task', 'reward']);
const EVENT_TTL_MS = 5 * 60 * 1000;   // a confirmation can be spent for 5 minutes, then it expires
const MAX_PENDING = 3;                // per user per block — stops stockpiling confirmations

export const s2sRequired = () => process.env.ADSGRAM_S2S_REQUIRED === '1';

function safeEq(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// GET /api/adsgram/reward?userid=..&block=task|reward&secret=..   (called by Adsgram, not by the app)
export async function handleAdsgramReward(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const secret = process.env.ADSGRAM_S2S_SECRET;
    if (!secret) return res.status(500).json({ ok: false, error: 'not_configured' });
    const { userid, block, secret: given } = req.query || {};
    if (typeof given !== 'string' || !safeEq(given, secret)) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (typeof userid !== 'string' || !/^\d{1,20}$/.test(userid) || !BLOCKS.has(block)) return res.status(400).json({ ok: false, error: 'bad_request' });

    try {
        const { db } = await connectToDatabase();
        const col = db.collection('adsgramS2S');
        const since = new Date(Date.now() - EVENT_TTL_MS);
        const pending = await col.countDocuments({ userId: userid, block, used: false, at: { $gte: since } });
        if (pending < MAX_PENDING) {
            await col.insertOne({ userId: userid, block, used: false, at: new Date(), expireAt: new Date(Date.now() + 24 * 3600 * 1000) });
        }
        return res.status(200).json({ ok: true }); // 200 even when capped, so Adsgram does not keep retrying
    } catch (e) {
        console.error('adsgram s2s error:', e);
        return res.status(500).json({ ok: false, error: 'server_error' }); // non-200 → Adsgram may retry
    }
}

// Spend ONE confirmation for (userId, block). Waits up to waitMs for the callback (it can arrive a moment
// after the in-app `reward` event). Returns true when enforcement is off, or a confirmation was spent.
export async function consumeAdsgramS2S(userId, block, { db = null, waitMs = 6000 } = {}) {
    if (!s2sRequired()) return true;
    const database = db || (await connectToDatabase()).db;
    const col = database.collection('adsgramS2S');
    const deadline = Date.now() + waitMs;
    for (;;) {
        const hit = await col.findOneAndUpdate(
            { userId: String(userId), block, used: false, at: { $gte: new Date(Date.now() - EVENT_TTL_MS) } },
            { $set: { used: true, usedAt: new Date() } },
            { sort: { at: 1 } }
        );
        const doc = hit && hit.value !== undefined ? hit.value : hit; // driver v5 vs v6 return shape
        if (doc) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, 600));
    }
}
