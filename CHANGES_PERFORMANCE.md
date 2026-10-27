# Performance pass — changes & deploy notes

## Changed files
| File | Change |
|---|---|
| `index.html` | Client-side pager (10/page) for the Task tab and "My Created Tasks"; Create-Task payment poll skips while the app is hidden |
| `css/vyrova.css` | `.pager` styles (appended) |
| `i18n.js` | Lazy per-language tables, memoised `tr()`, MutationObserver attached only for non-English; pager strings in all 7 languages |
| `api/data.js` | `type=tasks` now uses a projection (only fields the app reads) |
| `api/ops.js`, `models/schema.js` | New indexes `users.referralCount:-1`, `users.createdAt:-1` |
| `tests/*` | New (package.json referenced `tests/register.mjs` which did not exist) |

## Deploy requirement
Open `/api/admin/setup-indexes?secret=<BOT_TOKEN>` once after deploying to create the two new indexes (idempotent).

## Tests
`npm test` (13 unit tests, no DB/network needed).
Browser: `NODE_PATH=<global node_modules> node tests/browser/ui.mjs` (needs Playwright + Chromium; API/Telegram are stubbed).
`SECTIONS=5` runs only the measurement step; `TARGET=<dir>` points it at another copy (e.g. the original) for comparison.

## Known pre-existing issue (NOT changed)
`models/schema.js` is truncated mid-comment in the supplied ZIP (SyntaxError at EOF), so `npm run setup-db` cannot run.
The deploy path above (`ops.js`) is unaffected.
