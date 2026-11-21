// lib/paginate.js — one shared pagination helper for the whole project.
//
// Two styles, both safe against huge / hostile input (page=99999999, limit=1e9, NaN, arrays, objects):
//
//  1) PAGE style   ?page=1&limit=20            → good for small, rarely-changing lists (games, tasks, videos)
//        const { page, limit, skip } = pageParams(req.query, { defLimit: 20, maxLimit: 50 });
//        const rows = await col.find(f).sort(s).skip(skip).limit(limit + 1).toArray();   // +1 trick: no extra count query
//        const { items, meta } = pageResult(rows, { page, limit });
//
//  2) CURSOR style ?cursor=<opaque>&limit=20   → good for big / fast-growing lists (history, logs). No deep skip().
//        const { limit, cursor } = cursorParams(req.query);          // cursor = { t: ISO date, id: string } | null
//        const filter = { ...base, ...cursorFilter(cursor, 'createdAt') };
//        const rows = await col.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray();
//        const { items, meta } = cursorResult(rows, { limit, field: 'createdAt' });
//
// MAX_SKIP caps how deep ?page= can go: MongoDB skip() is O(n), so page=500000 would be a cheap DoS lever.

export const MAX_SKIP = 5000;

const toInt = (v, def) => {
    const x = Array.isArray(v) ? v[0] : v;
    const n = parseInt(typeof x === 'string' || typeof x === 'number' ? String(x) : '', 10);
    return Number.isFinite(n) ? n : def;
};

export function pageParams(q = {}, { defLimit = 20, maxLimit = 50, maxSkip = MAX_SKIP } = {}) {
    const limit = Math.min(Math.max(toInt(q.limit, defLimit), 1), maxLimit);
    let page = Math.max(toInt(q.page, 1), 1);
    const maxPage = Math.max(1, Math.floor(maxSkip / limit) + 1);
    if (page > maxPage) page = maxPage;
    return { page, limit, skip: (page - 1) * limit };
}

// rows must have been fetched with .limit(limit + 1)
export function pageResult(rows, { page, limit }) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, meta: { page, limit, count: items.length, hasMore, nextPage: hasMore ? page + 1 : null } };
}

// ---- cursor ----
const b64e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const b64d = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { return null; } };

export function cursorParams(q = {}, { defLimit = 20, maxLimit = 50 } = {}) {
    const limit = Math.min(Math.max(toInt(q.limit, defLimit), 1), maxLimit);
    const raw = Array.isArray(q.cursor) ? q.cursor[0] : q.cursor;
    let cursor = null;
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 200) {
        const c = b64d(raw);
        const t = c && typeof c.t === 'string' ? new Date(c.t) : null;
        if (t && !isNaN(t.getTime()) && typeof c.id === 'string' && c.id.length <= 64) cursor = { t, id: c.id };
    }
    return { limit, cursor };
}

// Mongo filter fragment: "strictly older than the cursor" for a (field desc, _id desc) sort.
// NOTE: only valid when _id is a string (all collections here use string/number ids set by the app); for ObjectId
// collections pass idCast = (s) => new ObjectId(s).
export function cursorFilter(cursor, field = 'createdAt', idCast = (s) => s) {
    if (!cursor) return {};
    return { $or: [{ [field]: { $lt: cursor.t } }, { [field]: cursor.t, _id: { $lt: idCast(cursor.id) } }] };
}

export function cursorResult(rows, { limit, field = 'createdAt' }) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last && last[field]
        ? b64e({ t: new Date(last[field]).toISOString(), id: String(last._id) })
        : null;
    return { items, meta: { limit, count: items.length, hasMore, nextCursor } };
}
