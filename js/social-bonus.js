/* js/social-bonus.js — optional "Bonus Time!" bottom sheet (+15 Points) shared by Mini Bot and Arrow Puzzle.
   The server creates the offer + the exact message (lib/socialBonus.js) and sends it as `bonus` with the 2nd-ad reward response.
   The sheet only copies that exact message and opens the official group; points are credited by the SERVER after the bot has seen the
   post, never because of a click.
     TxhSocialBonus.show(bonus)   open the sheet for a fresh offer
     TxhSocialBonus.resume()      re-open an offer the user already started (copy & open tapped) but has not claimed yet */
(function () {
  'use strict';
  if (window.TxhSocialBonus) return;
  var API = '/api/earn', cur = null, el = null, busy = false;

  function initData() {
    try { var w = window.Telegram && Telegram.WebApp; if (w && w.initData) return w.initData; } catch (e) {}
    try { var p = window.parent !== window && window.parent.Telegram && window.parent.Telegram.WebApp; if (p && p.initData) return p.initData; } catch (e) {}
    return '';
  }
  function call(action, body) {
    var d = initData(); if (!d) return Promise.reject(new Error('no_session'));
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, body, { action: action, initData: d })) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function tgw() { try { return (window.Telegram && Telegram.WebApp) || (window.parent !== window && window.parent.Telegram && window.parent.Telegram.WebApp) || null; } catch (e) { return null; } }

  /* copy must happen synchronously inside the tap (no awaiting before it) */
  function copyText(t) {
    var ok = false;
    try {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'; document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, t.length); ok = document.execCommand('copy'); ta.remove();
    } catch (e) {}
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(function () {}); } catch (e) {}
    return ok;
  }
  function openGroup(url) {
    var w = tgw();
    try { if (w && w.openTelegramLink) return w.openTelegramLink(url); } catch (e) {}
    try { window.open(url, '_blank'); } catch (e) { location.href = url; }
  }

  var CSS = '.txsb-bd{position:fixed;inset:0;z-index:2147483000;background:rgba(3,2,12,.62);display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .2s}' +
    '.txsb-bd.in{opacity:1}' +
    '.txsb{width:100%;max-width:520px;box-sizing:border-box;padding:10px 18px calc(18px + env(safe-area-inset-bottom,0px));color:#eaf2ff;font-family:"Chakra Petch","Segoe UI",system-ui,-apple-system,sans-serif;' +
    'background:linear-gradient(165deg,#241660 0%,#0d1238 60%,#080a22 100%);border:1px solid rgba(124,140,255,.35);border-bottom:0;border-radius:26px 26px 0 0;box-shadow:0 -12px 50px rgba(95,70,255,.35);transform:translateY(100%);transition:transform .28s cubic-bezier(.2,.9,.3,1);position:relative;overflow:hidden}' +
    '.txsb-bd.in .txsb{transform:none}' +
    '.txsb::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,#3df2ff,#a24bff,transparent)}' +
    '.txsb-grab{width:42px;height:4px;border-radius:4px;background:rgba(255,255,255,.22);margin:2px auto 12px}' +
    '.txsb-top{display:flex;align-items:center;justify-content:space-between;gap:10px}' +
    '.txsb h2{margin:0;font-size:24px;letter-spacing:.2px;font-weight:700}' +
    '.txsb-pts{flex:none;padding:6px 12px;border-radius:999px;font-weight:700;font-size:14px;color:#04120d;background:linear-gradient(135deg,#46e0a8,#3df2ff)}' +
    '.txsb p{margin:8px 0 12px;font-size:14px;line-height:1.45;color:#a9b6e6}' +
    '.txsb-card{position:relative;padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.06);border:1px dashed rgba(143,160,214,.45);font-size:14px;line-height:1.5;color:#f2f6ff;word-break:break-word;user-select:text;-webkit-user-select:text}' +
    '.txsb-lbl{display:block;font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#8fa0d6;margin-bottom:6px}' +
    '.txsb-btn{display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:14px 16px;border:0;border-radius:16px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#a24bff,#2f7bff);box-shadow:0 8px 24px rgba(80,90,255,.35)}' +
    '.txsb-btn.ok{color:#04120d;background:linear-gradient(135deg,#46e0a8,#3df2ff);box-shadow:0 8px 24px rgba(61,242,255,.25)}' +
    '.txsb-btn:disabled{opacity:.55;cursor:default}' +
    '.txsb-no{display:block;margin:10px auto 0;padding:8px 14px;background:none;border:0;color:#8fa0d6;font:inherit;font-size:14px;cursor:pointer}' +
    '.txsb-msg{min-height:18px;margin-top:10px;font-size:13px;line-height:1.4;text-align:center;color:#ffb3c6}.txsb-msg.good{color:#46e0a8}' +
    '@media (prefers-reduced-motion:reduce){.txsb,.txsb-bd{transition:none}}';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function say(t, good) { var m = el && el.querySelector('.txsb-msg'); if (m) { m.textContent = t || ''; m.className = 'txsb-msg' + (good ? ' good' : ''); } }
  function close() {
    if (!el) return; var e = el; el = null; cur = null; busy = false; e.classList.remove('in');
    setTimeout(function () { try { e.remove(); } catch (x) {} }, 260);
  }

  var FAIL = {
    not_verified: 'We could not find your post yet. Post the exact message in the group (not edited, not forwarded), wait a few seconds, then try again.',
    expired: 'This bonus has expired.', already_claimed: 'This bonus was already claimed.', not_found: 'This bonus could not be found.',
    not_available: 'This bonus is no longer available.', not_eligible: 'Your account is under review, so the bonus cannot be credited right now.',
  };

  function render() {
    if (el) { try { el.remove(); } catch (e) {} }
    if (!document.getElementById('txsb-css')) { var st = document.createElement('style'); st.id = 'txsb-css'; st.textContent = CSS; document.head.appendChild(st); }
    var b = cur, started = !!b.opened;
    el = document.createElement('div'); el.className = 'txsb-bd'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Bonus Time');
    el.innerHTML = '<div class="txsb"><div class="txsb-grab"></div>' +
      '<div class="txsb-top"><h2>Bonus Time!</h2><span class="txsb-pts">+' + b.points + ' Points</span></div>' +
      '<p>Want <b>' + b.points + ' extra points</b>? Share TON X HUB with the community: copy the message below, post it in our official Telegram group, then come back and claim.</p>' +
      '<div class="txsb-card"><span class="txsb-lbl">Your message</span><span id="txsbText"></span></div>' +
      '<button class="txsb-btn" id="txsbGo">Copy &amp; Open Telegram Group</button>' +
      '<button class="txsb-btn ok" id="txsbClaim"' + (started ? '' : ' hidden') + '>I’ve Posted It · Claim +' + b.points + '</button>' +
      '<div class="txsb-msg" aria-live="polite"></div>' +
      '<button class="txsb-no" id="txsbNo">No Thanks</button></div>';
    el.querySelector('#txsbText').textContent = b.message; // textContent: the message is shown exactly as generated
    document.body.appendChild(el);
    requestAnimationFrame(function () { el && el.classList.add('in'); });

    el.querySelector('#txsbGo').onclick = function () {
      var copied = copyText(cur.message), id = cur.id;            // exact server-generated text, copied synchronously
      call('socialBonusOpen', { bonusId: id }).catch(function () {}); // progress marker only
      cur.opened = true;
      var c = el.querySelector('#txsbClaim'); if (c) c.hidden = false;
      say(copied ? 'Message copied! Paste it in the group, post it, then return here.' : 'Press and hold the message above to copy it, then paste it in the group.', true);
      openGroup(cur.groupUrl);
    };
    el.querySelector('#txsbClaim').onclick = function () {
      if (busy) return; busy = true; var btn = this; btn.disabled = true; say('Checking your post…', true);
      call('socialBonusClaim', { bonusId: cur.id }).then(function (r) {
        if (r && r.ok) {
          say('+' + r.reward + ' points added. Thank you for sharing!', true);
          try { var w = tgw(); w && w.HapticFeedback && w.HapticFeedback.notificationOccurred('success'); } catch (e) {}
          try { window.dispatchEvent(new CustomEvent('txh:social-bonus-claimed', { detail: r })); } catch (e) {}
          setTimeout(close, 1600);
        } else { busy = false; btn.disabled = false; say(FAIL[r && r.reason] || 'Could not verify right now. Please try again in a moment.'); }
      }).catch(function () { busy = false; btn.disabled = false; say('Network problem. Nothing was lost, please try again.'); });
    };
    el.querySelector('#txsbNo').onclick = function () { if (busy) return; var id = cur.id; call('socialBonusDismiss', { bonusId: id }).catch(function () {}); close(); };
    el.addEventListener('click', function (e) { if (e.target === el && !busy) close(); }); // tapping outside just hides it; the offer stays valid until it expires
  }

  window.TxhSocialBonus = {
    show: function (bonus) { if (!bonus || !bonus.id || !bonus.message || el) return; cur = Object.assign({}, bonus); render(); },
    resume: function () {
      if (el) return;
      call('socialBonusStatus', {}).then(function (r) { if (r && r.ok && r.bonus && !el) { cur = Object.assign({}, r.bonus); render(); } }).catch(function () {});
    },
  };
})();
