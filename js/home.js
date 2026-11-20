/* ═══════════════════════════════════════════════════════════════════════════
   TON X HUB — HOME v2 (UI layer).  Loaded after js/fx.js and BEFORE the main inline script.

   What this file is:   the Home screen's markup + small view helpers.
   What it is NOT:      it never credits, claims, calculates or stores anything.
     • Balance / earned totals / referral numbers  → read from state.user (the server's profile response).
     • Daily reward  → markup from dcCardInner() in index.html; the claim itself is the unchanged
                       server-verified flow (api/earn.js → lib/dailyClaim.js).
     • Tasks         → state.tasks (api/data.js?type=tasks) + the existing goToTask() claim flow.
     • Leaderboard   → api/data.js?type=weeklyContest (real weekly referral ranking).
     • Level         → cosmetic, same formula as the Profile tab (every 5,000 TXH = +1). Gates nothing.
   It relies on globals that index.html defines (state, esc, fmtWTC, avatarHtml, switchTab, goToTask, apiGet …);
   they are only touched at call time, long after both scripts have loaded.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const HX_PTR_ENABLED = true;        // pull-to-refresh on Home. It needs Telegram's swipe-down-to-close gesture OFF while Home is open (set false to restore it).
const HX_TTL = { weekly: 60000, tasks: 30000 };   // client-side cache windows (ms) so re-rendering Home never spams the API
const HX_TASKS_SHOWN = 3;

const hx = {
    tasks:  { at: 0, busy: false, err: false, p: null },
    weekly: { at: 0, busy: false, err: false, p: null },
    ptr:    { y0: 0, track: false, on: false, pull: 0, busy: false, armed: false, bound: false },
};

/* ── tiny view helpers ───────────────────────────────────────────────────── */
const hxUse = (id, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 48 48" aria-hidden="true" focusable="false"><use href="#hx-i-${id}"/></svg>`;
const hxStroke = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const HX_CHEV = hxStroke('<path d="M9 18l6-6-6-6"/>', 2.6);
const HX_GLOBE = hxStroke('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>', 1.8);
const HX_BELL = hxStroke('<path d="M6 9.5a6 6 0 0112 0c0 5.2 2 6.6 2 6.6H4s2-1.400 2-6.600zM10 19.500a2.200 2.200 0 004 0"/>', 1.8);
const HX_FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12.5 2.500c.6 3-1.400 4.600-2.800 6.200C8.200 10.400 7 12.200 7 14.600a5 5 0 0010 0c0-1.800-.8-3.200-1.600-4.200-.2 1.200-.8 2-1.600 2.200.6-3.200-.2-7.400-1.300-10.100z" fill="#F08A24"/></svg>';
const HX_CROWN = '<svg class="hxp-crown" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 18.500L4.600 7.500l4.600 4.200L12 4.500l2.800 7.200 4.600-4.200L21 18.500z" fill="url(#hxGoldG)" stroke="#9C7A2E" stroke-width="1" stroke-linejoin="round"/><rect x="3" y="18.500" width="18" height="2.600" rx="1.300" fill="url(#hxGoldD)"/></svg>';
const HX_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.500l2.900 6 6.500.9-4.700 4.600 1.100 6.500L12 17.400l-5.800 3.100 1.100-6.500L2.600 9.400l6.500-.9z" fill="url(#hxGoldG)" stroke="#9C7A2E" stroke-width=".8" stroke-linejoin="round"/></svg>';
const HX_GIFT_SM = hxStroke('<path d="M20 12v8.500H4V12M2.500 7.500h19V12h-19zM12 7.500v13M12 7.500S10.800 3.500 8 3.500a2 2 0 000 4M12 7.500s1.200-4 4-4a2 2 0 010 4"/>', 2);
const HX_REFRESH = hxStroke('<path d="M20 11a8 8 0 10-2.300 5.700M20 4v7h-7"/>', 2.2);

function hxCoinSvg(cls) { return `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 200 200" aria-hidden="true" focusable="false"><use href="#hx-coin"/></svg>`; }

/* ═══ 1 · SHARED HEADER + DOCK helpers (called from index.html) ═══════════════ */
function hxSetHomeMode(on) {
    const root = document.getElementById('app-root');
    if (root) root.classList.toggle('is-home', !!on);
}

// Telegram chrome that depends on the screen: green header on Home, ivory elsewhere; swipe-to-close only matters on Home (pull-to-refresh).
function hxSyncChrome() {
    try { if (typeof earnGame !== 'undefined' && earnGame) return; } catch (e) { /* games own the chrome while open */ }
    const home = state.activeTab === 'home';
    const tgw = window.Telegram && window.Telegram.WebApp;
    try { tgw && tgw.setHeaderColor && tgw.setHeaderColor(home ? '#0E4A33' : '#F4F1E6'); } catch (e) { /* older clients */ }
    try { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', home ? '#0E4A33' : '#F4F1E6'); } catch (e) { /* ignore */ }
    if (HX_PTR_ENABLED) {
        try { home ? (tgw && tgw.disableVerticalSwipes && tgw.disableVerticalSwipes()) : (tgw && tgw.enableVerticalSwipes && tgw.enableVerticalSwipes()); } catch (e) { /* needs Bot API 7.7+ */ }
    }
}

// Bell badge = real pending withdrawals (the only "update" the backend has). Hidden when there is nothing pending.
function hxSyncBadge() {
    const el = document.getElementById('notif-badge');
    if (!el) return;
    let n = 0;
    if (Array.isArray(state.withdrawHistory)) n = state.withdrawHistory.filter(h => h && h.status === 'pending').length;
    else if (state.withdrawStatus && state.withdrawStatus.withdrawPending) n = 1;
    el.textContent = n > 9 ? '9+' : String(n);
    el.hidden = n === 0;
    const btn = document.getElementById('history-btn');
    if (btn) btn.setAttribute('aria-label', n ? `Withdrawal updates, ${n} pending` : 'Withdrawal updates');
}

/* ═══ 2 · DATA LOADERS (cached, one request in flight, section-level repaint) ═══ */
async function hxLoadTasks(force = false) {
    const s = hx.tasks;
    if (Array.isArray(state.tasks) && !s.at) s.at = Date.now();       // startApp() already preloaded them
    if (s.busy) return s.p;
    if (!force && Array.isArray(state.tasks) && Date.now() - s.at < HX_TTL.tasks) return;
    s.busy = true;
    s.p = (async () => {
        try {
            const r = await apiGet('data?type=tasks');
            if (r && r.ok && Array.isArray(r.tasks)) { state.tasks = r.tasks; s.at = Date.now(); s.err = false; }
            else if (!Array.isArray(state.tasks)) s.err = true;
        } catch (e) { if (!Array.isArray(state.tasks)) s.err = true; }
        s.busy = false;
        hxPaintTasks();
    })();
    return s.p;
}

async function hxLoadWeekly(force = false) {
    const s = hx.weekly;
    if (s.busy) return s.p;
    if (!force && Array.isArray(state.weeklyContest) && Date.now() - s.at < HX_TTL.weekly) return;
    s.busy = true;
    s.p = (async () => {
        try {
            const r = await apiGet('data?type=weeklyContest');
            if (r && r.ok && Array.isArray(r.top)) { state.weeklyContest = r.top; s.at = Date.now(); s.err = false; }
            else if (!Array.isArray(state.weeklyContest)) s.err = true;
        } catch (e) { if (!Array.isArray(state.weeklyContest)) s.err = true; }
        s.busy = false;
        hxPaintBoard();
    })();
    return s.p;
}

/* ═══ 3 · SECTIONS ═══════════════════════════════════════════════════════════ */
const hxSkRows = (n) => Array.from({ length: n }, () => '<div class="hxl-row is-sk"><i class="hx-sk ic"></i><span class="hxl-body"><i class="hx-sk"></i><i class="hx-sk"></i></span><i class="hx-sk bt"></i></div>').join('');
const hxState = (icon, title, text, btn = '') => `<div class="hxl-state">${hxUse(icon)}<b>${title}</b><p>${text}</p>${btn}</div>`;

function hxTaskRow(t) {
    const cat = t.category || 'partner';
    const m = TASK_CATEGORY_META[cat] || TASK_CATEGORY_META.partner;
    const verify = t.verifyType || (cat === 'channel' ? 'api' : 'link');
    const usdt = t.rewardCurrency === 'usdt';
    const amount = usdt ? (t.rewardUsdt ?? 0) : (t.rewardWtc || 0);
    const hint = verify === 'api' ? 'Join & verify' : 'Complete & claim';
    return `
        <div class="hxl-row" data-task-card="${esc(t._id)}">
            <span class="hxl-ico" style="background:${m.hueSoft};" aria-hidden="true">${m.icon}</span>
            <span class="hxl-body">
                <span class="hxl-title">${esc(t.title)}</span>
                <span class="hxl-meta"><span class="pill" style="background:${m.hueSoft}; color:${m.hue};">${m.badge}</span><span>${hint}</span></span>
            </span>
            <span class="hxl-rew"><b>+${esc(amount)}</b><small>${usdt ? 'USDT' : 'TXH'}</small></span>
            <button type="button" class="hxl-go hx-tap" data-hx-task="${esc(t._id)}" data-url="${esc(t.url || '')}" data-category="${esc(cat)}" data-verify="${esc(verify)}">Start</button>
        </div>`;
}

function hxTasksHtml() {
    if (!Array.isArray(state.tasks)) {
        if (hx.tasks.err) return hxState('tasks', 'Couldn\'t load tasks', 'Check your connection and try again.', '<button type="button" class="hxl-go hx-tap" data-hx-retry="tasks">Try again</button>');
        return hxSkRows(HX_TASKS_SHOWN);
    }
    const done = new Set((state.user && state.user.completedTasks) || []);
    const open = state.tasks.filter(t => !done.has(t._id));
    if (!state.tasks.length) return hxState('tasks', 'No tasks right now', 'New tasks are added often. Check back soon.');
    if (!open.length) return hxState('trophy', 'You\'re all caught up', 'You\'ve completed every available task. New ones are added often.');
    const picks = open.map((t, i) => ({ t, i })).sort((a, b) => ((b.t.rewardWtc || 0) - (a.t.rewardWtc || 0)) || (a.i - b.i)).slice(0, HX_TASKS_SHOWN).map(x => x.t);
    return picks.map(hxTaskRow).join('');
}

function hxPaintTasks() {
    const body = document.getElementById('hx-tasks-body');
    if (!body) return;                                                    // Home isn't on screen
    body.innerHTML = hxTasksHtml();
    const sub = document.getElementById('hx-tk-sub');
    if (sub && Array.isArray(state.tasks) && state.tasks.length) {
        const done = new Set((state.user && state.user.completedTasks) || []);
        const doneN = state.tasks.filter(t => done.has(t._id)).length;
        sub.textContent = tx('{0} of {1} completed', doneN, state.tasks.length);
    }
}

const hxPersonName = (p) => (p.telegramUsername && p.telegramUsername !== 'N/A') ? '@' + p.telegramUsername : (p.firstName || 'User');

function hxBoardHtml() {
    const list = state.weeklyContest;
    if (!Array.isArray(list)) {
        if (hx.weekly.err) return hxState('trophy', 'Couldn\'t load the leaderboard', 'Check your connection and try again.', '<button type="button" class="hxl-go hx-tap" data-hx-retry="board">Try again</button>');
        return hxSkRows(3);
    }
    if (!list.length) return hxState('trophy', 'No referrals yet this week', 'Invite a friend and be the first on the board.', '<button type="button" class="hxl-go hx-tap" data-hx-go="refer">Invite now</button>');
    const me = String(USER_ID);
    const myIdx = list.findIndex(p => String(p._id) === me);
    const row = (p, i, isMe) => `
        <div class="hxl-row${isMe ? ' is-me' : ''}">
            <span class="hxr-rank${i < 3 ? ' r' + (i + 1) : ''}">${i + 1}</span>
            <span class="hxr-av" aria-hidden="true">${isMe ? avatarHtml(FIRST_NAME, 40) : esc(((p.firstName || p.telegramUsername || '?') + '').trim().charAt(0).toUpperCase() || '?')}</span>
            <span class="hxl-body"><span class="hxr-name"><span translate="no">${esc(hxPersonName(p))}</span>${isMe ? '<i class="hxr-you">You</i>' : ''}</span></span>
            <span class="hxr-val">${esc(p.weeklyReferralCount || 0)} refs</span>
        </div>`;
    let html = list.slice(0, 3).map((p, i) => row(p, i, i === myIdx)).join('');
    const mine = (state.user && state.user.weeklyReferralCount) || 0;
    if (myIdx >= 3) html += row(list[myIdx], myIdx, true);
    else if (myIdx < 0) html += `<div class="hxl-mine"><span>${mine > 0 ? 'Not in the top 10 yet' : 'Invite friends to join this week\'s board'}</span>${mine > 0 ? `<em>${esc(mine)} refs</em>` : ''}</div>`;
    return html;
}

function hxPaintBoard() {
    const body = document.getElementById('hx-board-body');
    if (body) body.innerHTML = hxBoardHtml();
}

/* ═══ 4 · THE HOME SCREEN ═══════════════════════════════════════════════════ */
function renderHome() {
    const root = document.getElementById('tab-content');
    const u = state.user || {};
    const bal = Math.max(0, Number(u.wtcBalance) || 0);
    const prevBalance = window.__lastShownBalance ?? bal;
    // true on a real tab entrance, false when Home is just refreshed in place (after a claim, spin, gift …)
    const enter = root.dataset.enter === '1'; root.dataset.enter = '0';
    root.classList.toggle('no-enter', !enter);

    const lvl = Math.max(1, Math.floor(bal / 5000) + 1);                  // cosmetic — same formula as the Profile tab
    const lvlP = (bal % 5000) / 5000;
    const lvlPct = Math.round(lvlP * 100);
    const handle = USERNAME && USERNAME !== 'N/A' ? '@' + USERNAME : (u.telegramUsername && u.telegramUsername !== 'N/A' ? '@' + u.telegramUsername : '');
    const spinReady = spinCooldownMsRemaining(u) <= 0;
    const arrow = EARN_GAMES.find(x => x.id === 'arrow-puzzle'), mini = EARN_GAMES.find(x => x.id === 'mini-bot');
    const lazy = (art) => String(art).replace(/<img /, '<img loading="lazy" decoding="async" ');

    const gameCard = (id, art, name, sub, reward, extra = '') => `
        <button type="button" class="hxg-card hx-tap" data-hx-game="${esc(id)}" aria-label="${esc('Play ' + name)}">
            <span class="hxg-art">${art}${extra}</span>
            <span class="hxg-body"><span class="hxg-name">${esc(name)}</span><span class="hxg-sub">${esc(sub)}</span>${reward ? `<span class="hxg-chip">${esc(reward)}</span>` : ''}</span>
            <span class="hxg-go" aria-hidden="true">${HX_CHEV}</span>
        </button>`;
    const spinArt = `<span class="hxg-wheel" aria-hidden="true"><i style="background:${SPIN_WHEEL_GRADIENT};"></i>${hxCoinSvg()}</span>`;
    const qa = (id, go, icon, label, extra = '') => `<button type="button" class="hxq-i hx-tap" id="${id}" data-hx-go="${go}">${extra}${hxUse(icon)}<span>${label}</span></button>`;

    root.innerHTML = `
        <div class="hx-home">
            <button type="button" class="hxp hx-sec hx-tap" id="home-greet-btn" style="--hx-i:0" data-hx-go="profile" aria-label="Profile">
                <span class="hxp-av">${avatarHtml(FIRST_NAME, 56)}${HX_CROWN}</span>
                <span class="hxp-txt">
                    <span class="hxp-hi">Welcome back,</span>
                    <span class="hxp-name" translate="no"><span dir="ltr">${esc(FIRST_NAME)}!</span></span>
                    <span class="hxp-sub">${handle ? `<span translate="no" dir="ltr">${esc(handle)}</span><i>·</i>` : ''}<span>Level ${lvl}</span></span>
                </span>
                <span class="hxp-lv">
                    <span class="hxp-pill" translate="no">${HX_STAR}LV ${lvl}</span>
                    <span class="hxp-bar"><span class="hxp-track" role="progressbar" aria-label="Level progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${lvlPct}"><i style="--p:${lvlP.toFixed(3)}"></i></span><span class="hxp-pct">${lvlPct}%</span></span>
                </span>
            </button>

            <section class="hxb hx-sec" style="--hx-i:1" aria-label="TXH balance">
                <i class="hxb-glow" aria-hidden="true"></i>
                <i class="hxb-sp s1" aria-hidden="true"></i><i class="hxb-sp s2" aria-hidden="true"></i><i class="hxb-sp s3" aria-hidden="true"></i>
                <div class="hxb-coin" aria-hidden="true">
                    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
                        <g transform="rotate(-24 120 120)"><path d="M6 120A114 34 0 0 1 234 120" fill="none" stroke="url(#hxGoldD)" stroke-width="5" stroke-linecap="round"/></g>
                        <g transform="translate(40 40) scale(.8)"><use href="#hx-coin" width="200" height="200"/></g>
                        <g transform="rotate(-24 120 120)"><path d="M6 120A114 34 0 0 0 234 120" fill="none" stroke="url(#hxGoldG)" stroke-width="6" stroke-linecap="round"/></g>
                    </svg>
                </div>
                <div class="hxb-main">
                    <div class="hxb-label"><svg viewBox="0 0 48 48" aria-hidden="true"><use href="#hx-i-wallet-gold"/></svg><span>Total TXH Balance</span></div>
                    <div class="hxb-row"><span id="home-balance-num" class="hxb-num">${fmtWTC(prevBalance)}</span><span class="hxb-unit" translate="no">TXH</span></div>
                </div>
                <div class="hxb-stats">
                    <div class="hxb-stat">${hxUse('chart')}<span><em>Referral Earnings</em><b>+${fmtWTC(u.referralWtcEarned)} <small translate="no">TXH</small></b></span></div>
                    <i class="hxb-div" aria-hidden="true"></i>
                    <div class="hxb-stat">${hxUse('trophy')}<span><em>Total Earned</em><b>${fmtWTC(u.lifetimeWtcEarned)} <small translate="no">TXH</small></b></span></div>
                </div>
            </section>

            <nav class="hxq hx-sec" style="--hx-i:2" aria-label="Quick actions">
                ${qa('home-qi-task', 'tasks', 'tasks', 'Tasks')}
                ${qa('home-qi-games', 'games', 'pad', 'Games', '<i class="hxq-hot">Hot</i>')}
                ${qa('home-feat-withdraw', 'withdraw', 'wallet', 'Withdraw')}
                ${qa('home-promo-btn', 'redeem', 'gift', 'Redeem')}
            </nav>

            <!-- 📅 Daily Rewards: markup from dcCardInner() (display only); the claim is the unchanged server-verified flow -->
            <section class="hxd hx-sec" id="dc-card" style="--hx-i:3" aria-label="Daily Rewards">${dcCardInner()}</section>

            <section class="hx-sec" style="--hx-i:4" aria-labelledby="hx-pe-h">
                <div class="hxs-head">
                    <div class="hxs-t">${hxUse('pad')}<span><h2 class="hxs-h" id="hx-pe-h">Play &amp; Earn</h2></span></div>
                    <button type="button" class="hxs-link hx-tap" id="home-games-all" data-hx-go="games"><span>View all</span>${HX_CHEV}</button>
                </div>
                <div class="hxg-grid">
                    ${arrow ? gameCard(arrow.id, lazy(arrow.art), arrow.name, arrow.tagline, arrow.badge) : ''}
                    ${mini ? gameCard(mini.id, lazy(mini.art), mini.name, mini.tagline, mini.badge) : ''}
                    ${gameCard('spin', spinArt, 'Spin Wheel', 'Spin the wheel, win TXH COIN', 'Up to 100 TXH COIN', spinReady ? '<i class="hxg-ready" aria-hidden="true"></i>' : '')}
                </div>
            </section>

            <section class="hx-sec" style="--hx-i:5" aria-labelledby="hx-tk-h">
                <div class="hxs-head">
                    <div class="hxs-t">${hxUse('tasks')}<span><h2 class="hxs-h" id="hx-tk-h">Featured Tasks</h2><span class="hxs-s" id="hx-tk-sub">Complete available tasks</span></span></div>
                    <button type="button" class="hxs-link hx-tap" data-hx-go="tasks"><span>View all</span>${HX_CHEV}</button>
                </div>
                <div class="hxl" id="hx-tasks-body" aria-live="polite">${hxTasksHtml()}</div>
            </section>

            <section class="hx-sec" style="--hx-i:6" aria-labelledby="hx-lb-h">
                <div class="hxs-head">
                    <div class="hxs-t">${hxUse('trophy')}<span><h2 class="hxs-h" id="hx-lb-h">Weekly Leaderboard</h2><span class="hxs-s">Top referrers this week</span></span></div>
                    <button type="button" class="hxs-link hx-tap" id="home-milestone-btn" data-hx-go="weekly"><span>View all</span>${HX_CHEV}</button>
                </div>
                <div class="hxl" aria-live="polite">
                    <div id="hx-board-body">${hxBoardHtml()}</div>
                    <div class="hxl-foot"><button type="button" class="hxs-link hx-tap" id="home-leaderboard-btn" data-hx-go="alltime"><span>All-time top 20</span>${HX_CHEV}</button></div>
                </div>
            </section>

            <section class="hxi hx-sec" style="--hx-i:7" aria-label="Referral">
                <span class="hxi-ico" aria-hidden="true">${hxStroke('<circle cx="9" cy="8" r="3.6"/><path d="M2.800 20v-1.400a4.600 4.600 0 014.600-4.600h3.200a4.600 4.600 0 014.600 4.600V20"/><circle cx="17.600" cy="9" r="2.600"/><path d="M21.600 19.400v-1a3.600 3.600 0 00-2.400-3.400"/>', 1.8)}</span>
                <span class="hxi-txt"><span class="hxi-t">Invite &amp; Earn</span><span class="hxi-s"><span><b>${fmtWTC(u.referralCount)}</b> <span>Total referrals</span></span><span><b>${fmtWTC(u.referralWtcEarned)}</b> <span>Referral earnings</span></span></span></span>
                <button type="button" class="hxl-go hx-tap" id="home-qi-refer" data-hx-go="refer">Invite now</button>
            </section>
        </div>`;

    // Balance: fit beside the coin using the FINAL value, then count from the previous shown value to the real one
    // (never past it; with no change there is no animation at all).
    const balEl = document.getElementById('home-balance-num');
    balEl.textContent = fmtWTC(bal);
    VyFX.fitNumber(balEl, 44, 14);
    balEl.textContent = fmtWTC(prevBalance);
    animateCountUp(balEl, prevBalance, bal, prevBalance !== bal ? 1300 : 0);
    window.__lastShownBalance = bal;

    hxBindHome(root.querySelector('.hx-home'));
    dcBindCard();
    dcLoadStatus();                 // real claim state from the server (cached 30 s)
    hxLoadTasks();                  // no-ops when fresh
    hxLoadWeekly();
    hxPaintTasks();                 // fills the "x of y completed" line from cached data
    hxSyncBadge();
    hxBindPtr();
    VyFX.refresh();
}

/* One delegated click handler per render: every control keeps routing to the feature that already existed. */
const HX_GO = {
    tasks:    () => switchTab('task'),
    games:    () => switchTab('earn'),
    withdraw: () => openWithdrawModal(),
    redeem:   () => openPromoModal(),
    refer:    () => switchTab('refer'),
    profile:  () => switchTab('profile'),
    weekly:   () => openWeeklyContestModal(),
    alltime:  () => openLeaderboardModal(),
};
function hxBindHome(home) {
    if (!home) return;
    home.addEventListener('pointerdown', (e) => { if (e.target.closest('.hx-tap')) VyFX.haptic && VyFX.haptic('light'); }, { passive: true });
    home.addEventListener('click', (e) => {
        const t = e.target.closest('[data-hx-task],[data-hx-game],[data-hx-retry],[data-hx-go]');
        if (!t || !home.contains(t)) return;
        if (t.dataset.hxTask) {
            if (!Array.isArray(state.tasks)) return;
            goToTask(t.dataset.hxTask, t.dataset.url, t.dataset.category, t.dataset.verify);
        } else if (t.dataset.hxGame) {
            if (t.dataset.hxGame === 'spin') openSpinWheelModal(); else openEarnGame(t.dataset.hxGame);
        } else if (t.dataset.hxRetry) {
            if (t.dataset.hxRetry === 'tasks') { hx.tasks.err = false; hxPaintTasks(); hxLoadTasks(true); }
            else { hx.weekly.err = false; hxPaintBoard(); hxLoadWeekly(true); }
        } else if (HX_GO[t.dataset.hxGo]) {
            HX_GO[t.dataset.hxGo]();
        }
    });
}

/* ═══ 5 · PULL-TO-REFRESH (Home only) ═══════════════════════════════════════ */
function hxPtrEl() {
    let el = document.getElementById('hx-ptr');
    if (!el) { el = document.createElement('div'); el.id = 'hx-ptr'; el.className = 'hx-ptr'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = HX_REFRESH; document.body.appendChild(el); }
    return el;
}
function hxPtrCanStart() {
    if (!HX_PTR_ENABLED || state.activeTab !== 'home' || hx.ptr.busy) return false;
    if (window.scrollY > 0) return false;
    const mr = document.getElementById('modal-root');
    if (mr && mr.firstElementChild) return false;
    try { if (typeof earnGame !== 'undefined' && earnGame) return false; } catch (e) { /* ignore */ }
    return true;
}
function hxPtrPaint(pull, settle) {
    const el = hxPtrEl();
    el.classList.toggle('is-settling', !!settle);
    el.style.transform = `translate3d(0, ${pull - 52}px, 0)`;
    el.style.opacity = String(Math.min(1, pull / 36));
    const svg = el.firstElementChild; if (svg && !el.classList.contains('is-busy')) svg.style.transform = `rotate(${Math.round(pull * 4)}deg)`;
}
function hxBindPtr() {
    if (hx.ptr.bound || !HX_PTR_ENABLED) return;
    hx.ptr.bound = true;
    const p = hx.ptr, html = document.documentElement;
    document.addEventListener('touchstart', (e) => {
        p.track = e.touches.length === 1 && hxPtrCanStart(); p.on = false; p.armed = false; p.pull = 0;
        if (p.track) p.y0 = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!p.track) return;
        const dy = e.touches[0].clientY - p.y0;
        if (!p.on) {
            if (dy < -6 || window.scrollY > 0) { p.track = false; return; }          // user is scrolling the page, not pulling
            if (dy < 10) return;
            p.on = true; html.classList.add('hx-pulling');
        }
        if (e.cancelable) e.preventDefault();                                          // stop the native bounce while we own the gesture
        p.pull = Math.min((dy - 10) * 0.55, 84);
        if (!p.armed && p.pull >= 56) { p.armed = true; VyFX.haptic && VyFX.haptic('select'); }
        if (p.armed && p.pull < 56) p.armed = false;
        hxPtrPaint(p.pull, false);
    }, { passive: false });
    const end = () => {
        if (!p.track && !p.on) return;
        const fire = p.on && p.pull >= 56;
        p.track = false; html.classList.remove('hx-pulling');
        if (fire) hxRefreshHome(); else if (p.on) hxPtrPaint(0, true);
        p.on = false;
    };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
}

async function hxRefreshHome() {
    if (hx.ptr.busy) return;
    hx.ptr.busy = true;
    const el = hxPtrEl(); el.classList.add('is-busy'); hxPtrPaint(52, true);
    let ok = true, banned = false;
    try { await refreshUser(); } catch (e) { ok = false; banned = e && e.message === 'banned'; }
    if (!banned) {
        const [dc, tk, wk, ws] = await Promise.allSettled([
            dcLoadStatus(true), hxLoadTasks(true), hxLoadWeekly(true),
            apiGet(`withdraw?action=status&initData=${encodeURIComponent(TG_INIT_DATA)}`).then(r => { if (r && r.ok) state.withdrawStatus = r; }),
        ]);
        if (state.withdrawHistory) state.withdrawHistory = null;                      // re-read next time the history sheet opens
        if (hx.tasks.err || hx.weekly.err) ok = false;
        void dc; void tk; void wk; void ws;
    }
    el.classList.remove('is-busy'); hxPtrPaint(0, true);
    hx.ptr.busy = false;
    if (banned) return;                                                              // refreshUser() already showed the ban screen
    if (state.activeTab === 'home' && !(document.getElementById('modal-root') || {}).firstElementChild) renderHome();
    toast(ok ? 'Home updated' : 'Couldn\'t refresh everything. Check your connection and try again.', ok ? 'success' : 'error');
    VyFX.haptic && VyFX.haptic(ok ? 'success' : 'error');
}
