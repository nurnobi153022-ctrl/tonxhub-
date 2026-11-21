// tests/security-sim.mjs — offline attack SIMULATION (no MongoDB, no network, no real secrets).
// Run:  node tests/security-sim.mjs
import crypto from 'node:crypto';
process.env.BOT_TOKEN = '123456:TEST_TOKEN_FOR_SIMULATION_ONLY_abcdefghij';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-connected';   // never used: Layer 1 is RAM only
process.env.OPS_SECRET = 'ops-secret-sim-value-123456789';

const { guardEdge, rejectBadSecret, clientIp } = await import('../lib/guard.js');
const { verifyTelegramInitData } = await import('../lib/telegramAuth.js');
const { opsAuthorized } = await import('../lib/opsAuth.js');
const { pageParams, pageResult, cursorParams, cursorResult } = await import('../lib/paginate.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`); };

const mkRes = () => { const r = { code: 200, headers: {}, headersSent: false,
    setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; r.headersSent = true; return r; } }; return r; };
const mkReq = (ip, extra = {}) => ({ headers: { 'x-vercel-forwarded-for': ip, ...(extra.headers || {}) }, query: extra.query || {}, body: extra.body, socket: {} });

console.log('\n── A. HTTP flood from ONE IP (Layer 1, RAM) ──');
{
    let ok = 0, limited = 0, blocked = 0;
    for (let i = 0; i < 500; i++) {
        const res = mkRes();
        const stopped = guardEdge(mkReq('203.0.113.7'), res);
        if (!stopped) ok++; else if (res.code === 429) { limited++; }
        if (stopped && res.headers['Retry-After'] >= 60) blocked++;
    }
    t('first ≤60 requests/10s pass', ok === 60, `passed=${ok}`);
    t('remaining flood is answered 429 (no DB touched)', limited === 440, `429s=${limited}`);
    t('IP is hard-blocked for minutes once it passes 180/10s', blocked > 0, `block responses=${blocked}`);
    const other = mkRes();
    t('a DIFFERENT real user/IP is not affected', guardEdge(mkReq('198.51.100.9'), other) === false);
}

console.log('\n── B. Oversized body ──');
{
    const res = mkRes();
    const stopped = guardEdge(mkReq('192.0.2.1', { headers: { 'content-length': String(5 * 1024 * 1024) } }), res);
    t('5 MB body rejected with 413 before parsing work', stopped && res.code === 413);
}

console.log('\n── C. Secret brute-force on /api/ops & webhook ──');
{
    const ip = '203.0.113.50';
    let first401 = 0;
    for (let i = 0; i < 30; i++) {
        const gr = mkRes();
        if (guardEdge(mkReq(ip), gr, { trusted: true })) break;       // already blocked
        const res = mkRes(); rejectBadSecret(mkReq(ip), res);
        if (res.code === 401) first401++;
    }
    const after = mkRes();
    const blockedNow = guardEdge(mkReq(ip), after, { trusted: true });
    t('after ~15 wrong secrets the IP is blocked (429)', blockedNow && after.code === 429, `401s before block=${first401}`);
    t('wrong secret is rejected', opsAuthorized({ headers: { authorization: 'Bearer nope' }, query: {} }) === false);
    t('empty bearer / empty ?secret= is rejected', opsAuthorized({ headers: { authorization: 'Bearer ' }, query: { secret: '' } }) === false);
    t('array ?secret[]=x (type confusion) is rejected', opsAuthorized({ headers: {}, query: { secret: ['x'] } }) === false);
    t('correct secret accepted', opsAuthorized({ headers: { authorization: 'Bearer ' + process.env.OPS_SECRET }, query: {} }) === true);
    t('old BOT_TOKEN no longer works once OPS_SECRET is set', opsAuthorized({ headers: {}, query: { secret: process.env.BOT_TOKEN } }) === false);
}

console.log('\n── D. Forging Telegram identity (initData) ──');
{
    const sign = (fields, token = process.env.BOT_TOKEN) => {
        const p = new URLSearchParams(fields);
        const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
        const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        p.set('hash', crypto.createHmac('sha256', key).update(dcs).digest('hex'));
        return p.toString();
    };
    const now = Math.floor(Date.now() / 1000);
    const good = sign({ auth_date: String(now), user: JSON.stringify({ id: 111, first_name: 'A' }) });
    t('genuine initData accepted', verifyTelegramInitData(good).ok === true);
    // attacker swaps user id but keeps the old hash
    const p = new URLSearchParams(good); p.set('user', JSON.stringify({ id: 999, first_name: 'Victim' }));
    t('tampered user id (account takeover attempt) rejected', verifyTelegramInitData(p.toString()).ok === false);
    t('signed with attacker\'s own bot token rejected', verifyTelegramInitData(sign({ auth_date: String(now), user: '{"id":1}' }, 'evil:token')).ok === false);
    t('expired (>24h) initData rejected', verifyTelegramInitData(sign({ auth_date: String(now - 90000), user: '{"id":1}' })).ok === false);
    t('future-dated initData rejected', verifyTelegramInitData(sign({ auth_date: String(now + 9999), user: '{"id":1}' })).ok === false);
    t('missing hash / empty / non-string rejected', !verifyTelegramInitData('auth_date=1').ok && !verifyTelegramInitData('').ok && !verifyTelegramInitData({ a: 1 }).ok);
    t('no user field rejected', verifyTelegramInitData(sign({ auth_date: String(now) })).ok === false);
}

console.log('\n── E. Pagination abuse / fuzz ──');
{
    const q = (o) => pageParams(o, { defLimit: 20, maxLimit: 50 });
    t('limit=1e9 clamped to max 50', q({ limit: '1000000000' }).limit === 50);
    t('limit=-5 / 0 / abc → safe', q({ limit: '-5' }).limit === 1 && q({ limit: '0' }).limit === 1 && q({ limit: 'abc' }).limit === 20);
    t('page=99999999 capped (skip stays ≤ 5000)', q({ page: '99999999' }).skip <= 5000, `skip=${q({ page: '99999999' }).skip}`);
    t('page=-3 / NaN → page 1', q({ page: '-3' }).page === 1 && q({ page: 'x' }).page === 1);
    t('array & object inputs ignored safely', q({ page: ['2', '3'], limit: { $gt: 1 } }).limit === 20);
    const rows = Array.from({ length: 21 }, (_, i) => ({ _id: String(i), createdAt: new Date(1000 * i) }));
    const r = pageResult(rows, { page: 1, limit: 20 });
    t('hasMore + trims the extra probe row', r.items.length === 20 && r.meta.hasMore && r.meta.nextPage === 2);
    t('last page → hasMore=false', pageResult(rows.slice(0, 5), { page: 3, limit: 20 }).meta.hasMore === false);
    const cr = cursorResult(rows, { limit: 20 });
    const back = cursorParams({ cursor: cr.meta.nextCursor });
    t('cursor round-trips', back.cursor && back.cursor.id === '19');
    t('garbage / injected cursor ignored', cursorParams({ cursor: 'not-base64!!' }).cursor === null && cursorParams({ cursor: Buffer.from('{"t":{"$gt":""},"id":{"$ne":1}}').toString('base64url') }).cursor === null);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
