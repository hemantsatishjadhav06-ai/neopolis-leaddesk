# Neopolis LeadDesk

WhatsApp AI concierge + human-in-the-loop sales inbox, built on Meta's **official WhatsApp Business Cloud API**. Your Google Sheet stays the source of truth for leads; LeadDesk is where the team watches the AI, takes over chats, and works prospects.

```
 Meta lead ads ──▶ Google Sheet ──▶ LeadDesk imports new leads (every 10 min)
                                          │
                                          ▼
                     13-day WhatsApp journey: 6 templates on days 0/2/4/7/10/13 (automatic, 9am–8pm IST)
                                          │  lead replies
                                          ▼
                     AI concierge answers instantly (OpenRouter), qualifies the lead,
                     and hands over to sales when corridor + budget are known or a
                     visit/call/price is requested  ──▶  status PROSPECT, mode HUMAN
                                          │
                                          ▼
                     Team inbox: full history, take over / hand back, reply, assign,
                     flag AI replies, pipeline statuses (IN_SALES → VISIT_BOOKED → WON/LOST)
                                          │
                                          ▼
                     Sheet mirror: lead_status + last_reply column + "Client Replies" tab
```

## What the team sees

| Screen | What it does |
|---|---|
| **Dashboard** | Pipeline funnel, AI activity, what needs a human right now, system health (WhatsApp, webhook, sheet, follow-ups). |
| **Inbox** | Every WhatsApp conversation live. Filters: *Needs human*, *Prospects*, *AI handling*, *Mine*. Chat shows lead / AI / human / template messages with delivery ticks and the AI's reasoning tags. **Take over** silences the AI for that lead; **Hand back to AI** resumes it. Reply box respects WhatsApp's 24-hour rule (templates when the window is closed). Right pane: status, assignee, requirements, ad-form answers, notes, history. |
| **Leads** | Table of every lead with filters, bulk actions (take over, pause follow-ups, assign, set status), CSV export, manual add. |
| **AI Review** | Supervision queue: each AI reply next to the message it answered, with intent / sentiment / hand-off tags. 👍 approves, 👎 flags with a note. |
| **Settings** | AI prompt & model, the 13-day journey editor (+ one-click template submission to Meta), send-mode safety switch, WhatsApp connection + number registration wizard, Google Sheet connector, team & roles. |

Roles: **admin** (everything), **agent** (inbox, leads, reviews), **viewer** (read-only).

## Lead statuses

`CREATED → CONTACTED → FOLLOWUP_1 … FOLLOWUP_5 → NO_RESPONSE` (the automated journey) · any reply → `REPLIED` · AI qualifies → `PROSPECT` · salesperson takes it → `IN_SALES → VISIT_BOOKED → WON / LOST` · "stop" → `OPTED_OUT` (never messaged again).

The same value is written to the sheet's `lead_status` column.

## The safety switches

* **Send mode** (Settings → Outreach): `off` (default — nothing goes to leads), `test` (only your test numbers), `live`.
* **AI enabled / default mode**: new leads can start in AI or human mode; any chat can be taken over at any time.
* **Auto hand-off**: the AI stops and alerts the team when a lead qualifies or asks for a person.
* Opt-out keywords are honoured in every mode.

## Run locally

```bash
npm install
cp .env.example .env         # fill in what you have; leave WA_MOCK=1 / AI_MOCK=1 / SHEETS_PROVIDER=memory to try it without any accounts
npm start                    # http://localhost:8080 → first visit creates the admin
npm test                     # end-to-end test with mocks
```

## Deploy

See `docs/DEPLOY.md` (Railway) and `docs/SHEET-CONNECTOR.md` (Google Sheet). Configuration is entirely environment variables — see `.env.example`.

## Project layout

```
src/server.js            Express app, static UI, webhook + API mounting
src/config.js            environment → config (all secrets)
src/settings.js          editable settings stored in SQLite (AI prompt, outreach, templates…)
src/db.js                SQLite schema (node:sqlite, no native build)
src/services/whatsapp.js Graph API client (send text/template, mark read, signature check, setup helpers)
src/services/ai.js       OpenRouter call → reply + structured analysis (intent, corridor, budget, qualified, hand-off)
src/services/conversation.js  inbound pipeline: dedupe → lead → opt-out → AI or human queue → sheet mirror
src/services/leads.js    statuses, hand-off / take-over, messages, stats, sheet queue
src/services/scheduler.js the journey scheduler (day-based steps), NO_RESPONSE, sheet import + queue processing
src/services/sync.js     sheet import (header mapping, phone normalisation) + queued write-back
src/services/sheets/     connectors: appsscript (recommended), serviceaccount, memory (tests)
src/routes/api.js        JSON API for the UI · src/routes/webhook.js  Meta webhook
public/                  the team UI (no build step)
apps-script/Code.gs      the Google Sheet connector script
tests/e2e.mjs            end-to-end test · scripts/screenshots.mjs  UI smoke test
```
