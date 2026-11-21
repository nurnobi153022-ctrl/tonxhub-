// api/data.js — public read-only data for the mini app.
//   GET /api/data?type=videos
//   GET /api/data?type=games
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard        (top 20 by referralCount)
//   GET /api/data?type=weeklyContest      (top 10 by weeklyReferralCount)
//
// PAGINATION (all five types): add ?page=1&limit=20 → { ..., meta: { page, limit, count, hasMore, nextPage } }.
//   • Without page/limit the old behaviour is kept (same list, same cap) so the current mini app keeps working;
//     `meta` is still returned. limit is clamped to the per-type max below and page depth is capped (lib/paginate.js).

import { connectToDatabase } from '../lib/mongodb.js';
import { guardPublic } from '../lib/guard.js';
import { pageParams, pageResult } from '../lib/paginate.js';

// Only these `type` values exist. Anything else is rejected BEFORE touching MongoDB.
const VALID_TYPES = new Set(['videos', 'games', 'tasks', 'leaderboard', 'weeklyContest']);
// Vercel's CDN serves repeated identical GETs from cache, so a flood of the same
// URL never even starts a serverless function (saves free-plan invocations + DB ops).
const CACHE_SECONDS = { videos: 20, games: 30, tasks: 20, leaderboard: 30, weeklyContest: 30 };
// legacy cap (no ?page/?limit) → default page size, and the hard max a caller may ask for per page
const PAGING = {
    videos:        { legacy: 50,  def: 20, max: 50 },
    games:         { legacy: 300, def: 30, max: 100 },
    tasks:         { legacy: 50,  def: 20, max: 50 },
    leaderboard:   { legacy: 20,  def: 20, max: 20 },
    weeklyContest: { legacy: 10,  def: 10, max: 10 },
};
// Runs the query with pagination. `build(skip, take)` must return the cursor with sort applied.
async function paged(type, query, build) {
    const cfg = PAGING[type];
    const wantsPaging = query.page !== undefined || query.limit !== undefined;
    const { page, limit, skip } = wantsPaging
        ? pageParams(query, { defLimit: cfg.def, maxLimit: cfg.max })
        : { page: 1, limit: cfg.legacy, skip: 0 };
    const rows = await build(skip, limit + 1).toArray();     // limit+1 → hasMore without a second count query
    return pageResult(rows, { page, limit });
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // 🛡️ Server Guard — Layer 1 + per-IP Layer 2 (public endpoint, no Telegram session)
    if (await guardPublic(req, res)) return;

    try {
        const { type } = req.query;
        if (!VALID_TYPES.has(type)) return res.status(400).json({ ok: false, error: 'unknown_type' });
        const s = CACHE_SECONDS[type];
        res.setHeader('Cache-Control', `public, s-maxage=${s}, stale-while-revalidate=${s * 3}`);
        const { db } = await connectToDatabase();

        if (type === 'videos') {
            const { items: videos, meta } = await paged('videos', req.query, (skip, take) => db.collection('videos')
                .find({ isActive: true })
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip).limit(take));
            return res.status(200).json({ ok: true, videos, meta });
        }

        // 🎮 NEW — Games section (admin adds games from the bot, stored in `games`)
        if (type === 'games') {
            const { items: games, meta } = await paged('games', req.query, (skip, take) => db.collection('games')
                .find({ isActive: true })
                .project({ title: 1, gameUrl: 1, thumbnail: 1 })
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip).limit(take));
            return res.status(200).json({ ok: true, games, meta });
        }

        if (type === 'tasks') {
            // Projection: only the fields the mini app reads (index.html taskCardHtml/goToTask).
            // Internal fields (channelId, createdBy, order refs, counters...) are no longer sent
            // to every client, which also shrinks this CDN-cached payload.
            const { items: tasks, meta } = await paged('tasks', req.query, (skip, take) => db.collection('tasks')
                .find({ isApproved: true })
                .project({ title: 1, category: 1, verifyType: 1, url: 1, rewardWtc: 1, rewardUsdt: 1, rewardCurrency: 1 })
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip).limit(take));
            return res.status(200).json({ ok: true, tasks, meta });
        }

        if (type === 'leaderboard') {
            // ফিক্স: আগে ভুলে lifetimeWtcEarned দিয়ে সর্ট হতো, কিন্তু লেবেল ছিল "Top Referrer" —
            // এখন আসল referralCount দিয়েই সর্ট ও দেখানো হচ্ছে
            const { items: top, meta } = await paged('leaderboard', req.query, (skip, take) => db.collection('users')
                .find({ isBanned: { $ne: true } })
                .project({ telegramUsername: 1, firstName: 1, referralCount: 1 })
                .sort({ referralCount: -1, _id: 1 })
                .skip(skip).limit(take));
            return res.status(200).json({ ok: true, leaderboard: top, meta });
        }

        // Weekly Referral Contest (mini app "Milestones" button). Reads
        // the SAME live `weeklyReferralCount` field the admin panel's a_weekly
        // screen uses, so it automatically reflects the admin's manual
        // "🔄 Reset week now" (bot.js a_weekly_reset_confirm) — no separate
        // reset needed here, it's the same field/collection.
        if (type === 'weeklyContest') {
            const { items: top, meta } = await paged('weeklyContest', req.query, (skip, take) => db.collection('users')
                .find({ isBanned: { $ne: true }, weeklyReferralCount: { $gt: 0 } })
                .project({ telegramUsername: 1, firstName: 1, weeklyReferralCount: 1 })
                .sort({ weeklyReferralCount: -1, _id: 1 })
                .skip(skip).limit(take));
            return res.status(200).json({ ok: true, top, meta });
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
