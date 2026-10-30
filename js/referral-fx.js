/* referral-fx.js — TON X HUB · Referral page visuals ONLY.
 *
 * Presentation layer for the Refer tab: builds the animated "Invite & Earn" hero
 * (3D coin + friend avatars + animated connecting lines + particles) and runs the
 * tiny controller around it. No network calls, no state, no business logic —
 * every number shown on the page is passed in by renderReferTab() in index.html.
 *
 * Animation is CSS + SVG (SMIL). JS only:
 *   • builds the markup,
 *   • pauses the hero when it is off-screen / the tab is hidden (battery),
 *   • plays the "copied" success animation.
 * Exposed as window.RefFX. Safe to remove: renderReferTab() falls back gracefully.
 */
(function () {
    'use strict';

    var CX = 170, CY = 150;                      // coin centre inside the 340×300 stage
    var W = 340, H = 300;

    // Decorative friend avatars (not user data). x/y in stage units, s = diameter px.
    var AVATARS = [
        { x: 50,  y: 60,  s: 46, t: 'sage',  tag: true  },
        { x: 170, y: 26,  s: 40, t: 'gold'  },
        { x: 290, y: 60,  s: 46, t: 'ivory', tag: true  },
        { x: 316, y: 170, s: 40, t: 'forest' },
        { x: 246, y: 268, s: 46, t: 'sage',  tag: true  },
        { x: 94,  y: 268, s: 42, t: 'gold'  },
        { x: 24,  y: 170, s: 40, t: 'ivory' }
    ];

    var PARTICLES = [ // [x%, y%, size px, duration s, delay s]
        [8, 82, 3, 9, 0], [18, 40, 2, 11, 2], [30, 90, 3, 8, 4], [44, 70, 2, 10, 1], [56, 88, 3, 12, 3],
        [68, 76, 2, 9, 5], [80, 92, 3, 10, 0.5], [90, 52, 2, 11, 2.5], [12, 62, 2, 13, 6], [74, 30, 3, 9, 1.5],
        [36, 22, 2, 12, 4.5], [60, 14, 2, 10, 3.5], [92, 78, 2, 8, 6.5], [4, 28, 3, 11, 7], [50, 54, 2, 13, 8]
    ];
    var SPARKLES = [ // [x%, y%, size px, delay s]
        [14, 22, 12, 0], [86, 30, 10, 1.2], [8, 58, 8, 2.4], [92, 66, 12, 0.6], [24, 86, 9, 1.8], [72, 8, 9, 3]
    ];

    var GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.6" r="4.1"/><path d="M3.8 21c.7-4.5 4.2-6.7 8.2-6.7s7.5 2.2 8.2 6.7z"/></svg>';

    function pathFor(a, i) {
        var mx = (CX + a.x) / 2, my = (CY + a.y) / 2;
        var dx = a.x - CX, dy = a.y - CY, len = Math.sqrt(dx * dx + dy * dy) || 1;
        var k = (i % 2 ? 1 : -1) * 14;           // gentle alternating curve
        var qx = mx + (-dy / len) * k, qy = my + (dx / len) * k;
        return 'M' + CX + ',' + CY + ' Q' + qx.toFixed(1) + ',' + qy.toFixed(1) + ' ' + a.x + ',' + a.y;
    }

    function heroStage() {
        var lines = '', pulses = '', avatars = '', i, a, d, begin;
        for (i = 0; i < AVATARS.length; i++) {
            a = AVATARS[i]; d = pathFor(a, i); begin = (i * 0.62).toFixed(2);
            lines +=
                '<path class="rf-ln-glow" d="' + d + '"/>' +
                '<path class="rf-ln" d="' + d + '"/>' +
                '<path class="rf-ln-flow" d="' + d + '" style="animation-delay:-' + (i * 0.7).toFixed(1) + 's"/>';
            pulses +=
                '<g class="rf-pulse">' +
                '<circle r="7" fill="url(#rfPulseGlow)"><animateMotion dur="2.6s" begin="' + begin + 's" repeatCount="indefinite" calcMode="spline" keyTimes="0;1" keySplines=".45 .05 .25 1" path="' + d + '"/>' +
                '<animate attributeName="opacity" dur="2.6s" begin="' + begin + 's" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.14;.82;1"/></circle>' +
                '<circle r="2.4" fill="#FFF6D0"><animateMotion dur="2.6s" begin="' + begin + 's" repeatCount="indefinite" calcMode="spline" keyTimes="0;1" keySplines=".45 .05 .25 1" path="' + d + '"/>' +
                '<animate attributeName="opacity" dur="2.6s" begin="' + begin + 's" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.14;.82;1"/></circle>' +
                '</g>';
            avatars +=
                '<div class="rf-av rf-av-' + a.t + '" style="left:' + (a.x / W * 100).toFixed(2) + '%;top:' + (a.y / H * 100).toFixed(2) + '%;--s:' + a.s + 'px;--d:' + (i * 0.62).toFixed(2) + 's">' +
                '<div class="rf-av-in" style="animation-delay:-' + (i * 1.1).toFixed(1) + 's">' +
                '<i class="rf-av-ring"></i>' + GLYPH +
                (a.tag ? '<b class="rf-av-tag">+500</b>' : '') +
                '</div></div>';
        }

        var parts = '', sp = '';
        PARTICLES.forEach(function (p) {
            parts += '<i class="rf-pt" style="left:' + p[0] + '%;top:' + p[1] + '%;width:' + p[2] + 'px;height:' + p[2] + 'px;animation-duration:' + p[3] + 's;animation-delay:-' + p[4] + 's"></i>';
        });
        SPARKLES.forEach(function (s) {
            sp += '<svg class="rf-sp" viewBox="-7 -7 14 14" style="left:' + s[0] + '%;top:' + s[1] + '%;width:' + s[2] + 'px;height:' + s[2] + 'px;animation-delay:' + s[3] + 's" aria-hidden="true"><path d="M0-6.5 1.5-1.5 6.5 0 1.5 1.5 0 6.5-1.5 1.5-6.5 0-1.5-1.5Z"/></svg>';
        });

        var coin = (window.VyFX && VyFX.coin3d) ? VyFX.coin3d({ size: 104 }) : (window.VyFX && VyFX.coinFlat ? VyFX.coinFlat(104) : '');

        return '' +
            '<div class="rf-stage" aria-hidden="true">' +
            '<div class="rf-rays"></div>' +
            '<i class="rf-ring"></i><i class="rf-ring rf-ring-x" style="animation-delay:-1.4s"></i><i class="rf-ring rf-ring-x" style="animation-delay:-2.8s"></i>' +
            '<svg class="rf-lines" viewBox="0 0 ' + W + ' ' + H + '" focusable="false">' +
            '<defs><radialGradient id="rfPulseGlow"><stop offset="0" stop-color="#FFE9A8" stop-opacity=".95"/><stop offset="1" stop-color="#D9C386" stop-opacity="0"/></radialGradient></defs>' +
            lines + pulses +
            '</svg>' +
            parts + sp + avatars +
            '<div class="rf-coin"><div class="rf-halo"></div>' + coin + '</div>' +
            '</div>';
    }

    /* ── controller ─────────────────────────────────────────────────────── */
    var io = null;
    function setRunning(hero, on) {
        if (!hero) return;
        hero.classList.toggle('rf-off', !on);
        var svg = hero.querySelector('.rf-lines');
        try { if (svg) { on ? svg.unpauseAnimations() : svg.pauseAnimations(); } } catch (e) { /* old WebView */ }
    }
    function mount(root) {
        var hero = root && root.querySelector('.rf-hero');
        if (!hero) return;
        if (io) { try { io.disconnect(); } catch (e) {} io = null; }
        var visible = true;
        function apply() { setRunning(hero, visible && !document.hidden); }
        if ('IntersectionObserver' in window) {
            io = new IntersectionObserver(function (es) {
                if (!hero.isConnected) { io.disconnect(); return; }
                visible = es[es.length - 1].isIntersecting; apply();
            }, { threshold: 0.01 });
            io.observe(hero);
        }
        var onVis = function () { if (!hero.isConnected) { document.removeEventListener('visibilitychange', onVis); return; } apply(); };
        document.addEventListener('visibilitychange', onVis);
        apply();
    }

    var COPY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 017.5 4H15"/></svg>';
    var CHECK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path class="rf-check" d="M5 12.5l4.6 4.6L19 7.5"/></svg>';

    /* Success animation for the Copy button(s) + link card. Pure presentation. */
    function copied(root) {
        var card = root.querySelector('.rf-link-card');
        var btn = root.querySelector('#refer-copy');
        var inl = root.querySelector('#refer-copy-inline');
        if (card) { card.classList.remove('is-copied'); void card.offsetWidth; card.classList.add('is-copied'); }
        if (btn) { btn.classList.add('is-ok'); btn.querySelector('.rf-ic').innerHTML = CHECK_ICON; btn.querySelector('.rf-lb').textContent = 'Copied!'; }
        if (inl) { inl.classList.add('is-ok'); inl.innerHTML = CHECK_ICON; }
        clearTimeout(copied._t);
        copied._t = setTimeout(function () {
            if (card) card.classList.remove('is-copied');
            if (btn && btn.isConnected) { btn.classList.remove('is-ok'); btn.querySelector('.rf-ic').innerHTML = COPY_ICON; btn.querySelector('.rf-lb').textContent = 'Copy Link'; }
            if (inl && inl.isConnected) { inl.classList.remove('is-ok'); inl.innerHTML = COPY_ICON; }
        }, 2000);
    }

    window.RefFX = { stage: heroStage, mount: mount, copied: copied, icons: { copy: COPY_ICON, check: CHECK_ICON } };
})();
