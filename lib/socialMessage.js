// lib/socialMessage.js — dynamic promo-message generator for the Social Sharing Bonus (lib/socialBonus.js).
//
// Pure module (no database, no network). Every call builds a NEW short English message about TON X HUB, mini games, rewards and the
// TON blockchain by combining a random sentence FRAME with random phrases from many pools (opener, what-it-is, benefit, call to
// action, emoji, hashtag …). Frames differ in structure (statement, question, exclamation, recommendation, mini-review, dotted
// list), so messages do not just reorder the same words. The caller (socialBonus.js) guarantees that no two bonuses ever get the
// same message by reserving each message hash in the database and asking for another one on a collision.
//
// No links, no @mentions, no ALL-CAPS, no promises of money — at most 2 emoji and 1 hashtag — so it reads like a normal member
// post and does not look like spam. Single line, plain text only (so Telegram hands back exactly what was pasted).

import crypto from 'crypto';

const pick = (a) => a[crypto.randomInt(a.length)];
const chance = (pct) => crypto.randomInt(100) < pct;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const GAME_NAME = { arrow: 'Arrow Puzzle', mini: 'Mini Bot' };
const OTHER_GAME = { arrow: 'Mini Bot', mini: 'Arrow Puzzle' };

const BRAND = ['TON X HUB', 'TON X HUB', 'TON X HUB', 'the TON X HUB mini app', 'the TON X HUB app', 'TON X HUB on Telegram'];

const OPENER = [
    'Quick share:', 'Hey everyone,', 'Hello TON fam,', 'Friendly tip:', 'Good news for TON fans:', 'Small find today:', 'Fun discovery:',
    'Hi all,', 'Just sharing:', 'Hey TON community,', 'For anyone who likes mini games:', 'Sharing a good one:', 'Quick note for the group:',
];

const PLAYED = [
    (g, b) => `Just wrapped up a round of ${g} on ${b}`,
    (g, b) => `Spent a few minutes playing ${g} on ${b}`,
    (g, b) => `Took a quick break with ${g} on ${b}`,
    (g, b) => `Been playing ${g} on ${b} today`,
    (g, b) => `Finished another ${g} session on ${b}`,
    (g, b) => `Just tried ${g} on ${b} and collected some points`,
    (g, b) => `Played ${g} on ${b} and picked up my rewards`,
    (g, b) => `Another ${g} round done on ${b}`,
    (g, b) => `Got my daily ${g} fix on ${b}`,
];

const WHAT_IS = [
    'a Telegram mini app packed with quick games and rewards',
    'a mini game hub where every round can earn you points',
    'a simple rewards app built around the TON blockchain',
    'a friendly place to play short games and collect points',
    'a Telegram hub that mixes mini games, rewards and the TON ecosystem',
    'a clean little app for playing mini games and earning points',
    'an easy way to enjoy mini games and rewards inside Telegram',
    'a growing community of mini game players in the TON ecosystem',
    'a mini game and rewards app made for the TON community',
    'a light and fun way to explore TON while you play',
];

const BENEFIT = [
    'Every round adds to your points',
    'The rewards make each game more fun',
    'It is an easy way to enjoy the TON ecosystem on Telegram',
    'No downloads needed, it opens right inside Telegram',
    'It is a nice way to fill a few spare minutes',
    'Simple to learn and hard to put down',
    'The games are short, so they fit into any break',
    'Great for anyone curious about the TON blockchain',
    'It fits right into the TON vibe',
    'Playing and earning at the same time is a nice mix',
    'Easy to start and rewarding to keep playing',
    'The daily rewards give you a reason to come back',
];

const CTA = [
    'Come take a look!', 'Give it a try and watch your points grow.', 'Worth checking out if you like TON.',
    'Join the community and play along.', 'Curious? Stop by and try it.', 'Would love to see more of you there.',
    'Try one round, you might like it.', 'See you in the next round!', 'Come and say hi to the community.',
    'Have a look and tell me what you think.', 'Jump in and see how many points you can collect.',
];

const INTEREST = [
    'mini games', 'puzzle games', 'quick games on Telegram', 'the TON blockchain', 'collecting rewards while you play',
    'casual games', 'TON projects', 'short games with real rewards',
];

const VERDICT = [
    'simple, smooth and surprisingly fun', 'easy to start and rewarding to keep playing', 'a great mix of games and rewards',
    'light, fast and actually enjoyable', 'a good fit for quick breaks', 'friendly, fun and full of mini games',
];

const TIDBIT = ['mini games', 'daily rewards', 'points for every round', 'a friendly TON community', 'puzzles and arcade fun', 'rewards on TON'];

const EMOJI = ['🚀', '🎮', '💎', '⚡', '✨', '🎯', '🧩', '🔥', '🌟', '👍'];
const HASHTAG = ['#TON', '#TONBlockchain', '#MiniGames', '#Telegram', '#PlayAndEarn'];

const FRAMES = [
    // statement flow
    (c) => `${c.opener} ${c.opener.endsWith(',') ? c.played.charAt(0).toLowerCase() + c.played.slice(1) : c.played}. ${c.benefit}. ${c.cta}`,
    // question first
    (c) => `Have you tried ${c.brand} yet? It is ${c.whatIs}. ${c.benefit}. ${c.cta}`,
    // brand first
    (c) => `${cap(c.brand)} is ${c.whatIs}. ${c.played}. ${c.cta}`,
    // exclamation
    (c) => `${c.played}! ${c.benefit}. ${c.cta}`,
    // recommendation
    (c) => `If you like ${c.interest}, check out ${c.brand}. It is ${c.whatIs}. ${c.cta}`,
    // mini review
    (c) => `My take on ${c.brand}: ${c.verdict}. ${c.played}. ${c.benefit}.`,
    // dotted list
    (c) => `${cap(c.brand)} · ${c.tidbits[0]} · ${c.tidbits[1]} · ${c.tidbits[2]}. ${c.cta}`,
    // discovery
    (c) => `${c.opener} I found ${c.brand}, ${c.whatIs}. ${c.played}. ${c.cta}`,
    // two-game mention
    (c) => `${c.played}, and ${c.otherGame} is next. ${cap(c.brand)} is ${c.whatIs}. ${c.cta}`,
];

// Builds ONE message. `game` ('arrow' | 'mini') makes it mention the game the user just played.
export function generateSocialMessage({ game } = {}) {
    const g = GAME_NAME[game] || pick(Object.values(GAME_NAME));
    const og = OTHER_GAME[game] || pick(Object.values(GAME_NAME));
    const brand = pick(BRAND);
    const tidbits = [];
    while (tidbits.length < 3) { const t = pick(TIDBIT); if (!tidbits.includes(t)) tidbits.push(t); }
    const c = {
        brand, opener: pick(OPENER), played: pick(PLAYED)(g, brand), whatIs: pick(WHAT_IS), benefit: pick(BENEFIT), cta: pick(CTA),
        interest: pick(INTEREST), verdict: pick(VERDICT), tidbits, otherGame: og,
    };
    let text = pick(FRAMES)(c);
    const e = chance(60) ? (chance(25) ? [pick(EMOJI), pick(EMOJI)] : [pick(EMOJI)]) : [];
    if (e.length === 2 && e[0] === e[1]) e.pop();
    if (e.length) text = chance(60) ? `${e[0]} ${text}${e[1] ? ' ' + e[1] : ''}` : `${text} ${e.join(' ')}`;
    if (chance(35)) text += ' ' + pick(HASHTAG);
    return text.replace(/\s+/g, ' ').trim();
}

// ── matching ────────────────────────────────────────────────────────────────────────────────────────────────────
// What Telegram returns for a pasted message can differ from the clipboard only in invisible ways (NBSP / zero-width characters,
// emoji variation selectors, a trailing newline). Those are ignored; every visible character must match exactly.
export function normalizeMessage(text) {
    return String(text ?? '')
        .normalize('NFC')
        .replace(/[-‍⁠﻿︎️]/g, '')
        .replace(/[\s ]+/g, ' ')
        .trim();
}
export const hashMessage = (text) => crypto.createHash('sha256').update(normalizeMessage(text)).digest('hex');
