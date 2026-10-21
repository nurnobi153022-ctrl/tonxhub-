// lib/opsAuth.js — shared-secret check for the operator/cron endpoints (api/ops.js, api/payments.js cron).
//
// FIX F-08: these endpoints used the Telegram BOT_TOKEN as the URL secret (?secret=<BOT_TOKEN>). The bot token
// is the master credential (it also signs every Mini-App initData), and URLs end up in access logs and in
// third-party cron services. Now a dedicated OPS_SECRET is used instead.
//
//   • OPS_SECRET set   → ONLY OPS_SECRET is accepted (the BOT_TOKEN stops working here).
//   • OPS_SECRET unset → legacy behaviour (BOT_TOKEN) so nothing breaks until you set it. Set it!
//
// The secret may be sent as   Authorization: Bearer <secret>   (preferred)   or as   ?secret=<secret>
// (for free cron services that cannot set headers). Comparison is constant-time.
import crypto from 'node:crypto';

function safeEq(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function opsSecret() {
    return process.env.OPS_SECRET || process.env.BOT_TOKEN || '';
}

export function opsAuthorized(req) {
    const secret = opsSecret();
    if (!secret) return false;
    const h = String(req.headers?.authorization || '');
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    const q = typeof req.query?.secret === 'string' ? req.query.secret : '';
    return (bearer !== '' && safeEq(bearer, secret)) || (q !== '' && safeEq(q, secret));
}
