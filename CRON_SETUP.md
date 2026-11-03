# ⏰ Cron + Notification setup (Create Task payment + 24h reminder)

## Ekta cron-i jothesto: `GET /api/cron/tick`
Ek ping-e tin-ta kaj hoy:
1. **Create Task payment check** — pending order thakle-i TonCenter-e jay, na thakle kono external call nei.
2. Cholte-thaka broadcast-er porer chunk pathay.
3. **24 ghonta por por** sokol (non-banned, bot-block-na-kora) user-ke Telegram bot-e notification pathay (6 ta caption ghure ghure).

Idle tick (kichu korar nei) = shudhu 3 ta halka DB query. Telegram/TonCenter call = 0.

## 1) Vercel Environment Variables
Project → Settings → Environment Variables → (Production tick dao) → Save → **Redeploy**.

### Must (na dile feature kaj korbe na)
| Name | Value |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `BOT_TOKEN` | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | je-kono lomba random string (A-Z a-z 0-9 _ -) |
| `ADMIN_ID` | tomar Telegram numeric ID |
| `TON_RECEIVE_ADDRESS` | je TON wallet-e Create Task-er payment ashbe |
| `OPS_SECRET` | notun, lomba random string — cron-job.org-er password (BOT_TOKEN ar URL-e dewa lagbe na) |
| `CRON_SECRET` | notun, lomba random string — Vercel nijer daily cron-e eta Bearer hishebe pathay |

### Optional
| Name | Default | Kaj |
|---|---|---|
| `MONGODB_DB` | `newtube` | database name |
| `TONCENTER_API_KEY` | — | @tonapibot theke free key; TonCenter beshi reliable hoy |
| `TASK_MODERATOR_ID` | — | new paid task review-er alert ei ID-o pabe |
| `REMINDER_INTERVAL_HOURS` | `24` | notification koto ghonta por por |
| `BROADCAST_BUDGET_MS` | `8000` | ek invocation-e koto ms message pathabe. `20000` dile invocation kom lage (vercel.json maxDuration 30 ache) |
| `TON_TX_FETCH_LIMIT` | `30` | ek check-e koto ta recent tx dekhbe |
| `OFFICIAL_CHANNEL_ID` / `COMMUNITY_GROUP_ID` / `PAYMENT_PROOF_GROUP_ID` | code-er default | channel/group ID override |
| `GUARD_USER_SOFT` … `GUARD_IP_MEM_PER_10S` | GUARD.md dekho | rate-limit tune |

## 2) Deploy-er por (ekbar)
1. `https://tonxhub.vercel.app/api/admin/setup-indexes?secret=<OPS_SECRET>`
2. `https://tonxhub.vercel.app/api/admin/set-webhook?secret=<OPS_SECRET>&drop=1`

## 3) cron-job.org (free) — payment 1-2 minute-e credit hobe
1. Login → **Create cronjob**
2. URL: `https://tonxhub.vercel.app/api/cron/tick`
3. Schedule: **Every 1 minute** (CPU aro kom chaile every 2 minutes)
4. Advanced → Headers → `Authorization` = `Bearer <OPS_SECRET>`
   (header na dewa gele URL-e `?secret=<OPS_SECRET>` dao)
5. Method GET → Save → Enable
6. Puroni 2 ta job (`/api/payments?cron=checkDeposits` ar `/api/broadcastTick`) **disable/delete** koro — ekhon `tick` duita-i kore, rakhle shudhu faltu invocation.

Test: browser-e `…/api/cron/tick?secret=<OPS_SECRET>` kholo → `{"ok":true,"payments":{...},"broadcast":{...}}` ashle thik.

## 4) Vercel nijer cron (backup)
`vercel.json`-e daily `0 14 * * *` (14:00 UTC = Bangladesh raat 8:00) set kora ache. Hobby plan-e shudhu dine ekbar cholte pare ar ±1 ghonta deri hote pare — tai eta backup; asol continuous kaj cron-job.org kore. Pro plan hole `"* * * * *"` dile cron-job.org lagbe-i na.

## Notification debug
- Status: `/api/broadcastStatus?secret=<OPS_SECRET>`
- Je user bot block korechhe tar kache ar pathano hoy na (`botBlocked`); se app khulle ba `/start` dile abar ferot ashe.
