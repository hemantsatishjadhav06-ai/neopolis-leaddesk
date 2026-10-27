# Deploying Neopolis LeadDesk on Railway

The app is a single Node service with a SQLite database on a persistent volume. It builds from the included `Dockerfile`.

## 1. Create the service (once)

1. Railway → **New Project** → **Empty service** (or let Claude create it for you through the Railway connector).
2. Service → **Settings → Volumes → Add volume**, mount path **`/data`** (this is where the database lives; without it data is lost on every deploy).
3. Service → **Settings → Networking → Generate domain** → note the URL (e.g. `https://leaddesk-production.up.railway.app`).

## 2. Set the variables

Service → **Variables** → add (see `.env.example` for the full list):

| Variable | Value |
|---|---|
| `PUBLIC_URL` | the Railway domain from step 1 |
| `DATA_DIR` | `/data` |
| `WHATSAPP_TOKEN` | permanent System User token |
| `PHONE_NUMBER_ID` | the registered sender's id |
| `WABA_ID` | `YOUR_WABA_ID` |
| `META_APP_ID` | `YOUR_META_APP_ID` |
| `META_APP_SECRET` | from Meta app → Settings → Basic |
| `VERIFY_TOKEN` | any string, e.g. `neopolis-leaddesk-verify` |
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `SPREADSHEET_ID` | `YOUR_SHEET_ID_HERE` |
| `SHEETS_APPS_SCRIPT_URL` / `SHEETS_APPS_SCRIPT_SECRET` | from `docs/SHEET-CONNECTOR.md` |
| `FIRMS` | optional: more firms with their own WhatsApp number and sheet, see `docs/FIRMS.md` |

Paste secrets directly in Railway's Variables tab — they never need to be in the code or in chat.

## 3. Upload the code

Option A — **Railway CLI** from any computer (no GitHub needed):

```bash
npm i -g @railway/cli
railway login                 # opens the browser once
cd leaddesk
railway link                  # pick the project + service created above
railway up                    # builds the Dockerfile and deploys
```

Option B — **GitHub**: push the folder to a private repo, then Service → Settings → Source → connect the repo. Every push redeploys.

## 4. First run

1. Open the domain → the setup screen creates the **admin** account.
2. Settings → **Team**: add your sales agents.
3. Settings → **WhatsApp**: check the connection lines are green. Paste the **Callback URL** + **Verify token** into Meta (App → WhatsApp → Configuration → Webhook → Edit, then subscribe to `messages`) — or click **Configure automatically** if `META_APP_SECRET` is set. Click **Subscribe app to WABA**.
4. Settings → **Google Sheet** → **Test connection** → **Import now**. Leads appear under *Leads*.
5. Send yourself a WhatsApp message to the business number → it appears in the Inbox with an AI reply within seconds.
6. Settings → **Outreach**: review the journey text, click **Submit templates to Meta**, wait for APPROVED, then set send mode to `test`, use *Run now* with your own number, and finally switch to `live`.

## Adding another firm

Set `FIRMS` (or use Settings → Firms), then follow `docs/FIRMS.md`: register the firm's number from Settings → WhatsApp with that firm selected, submit its templates, test, go live. The webhook, token and Meta app are shared, so nothing else changes in Meta or Railway.

The first deploy with firms rebuilds the `leads` table once (same number allowed in two firms). A snapshot named `leaddesk-pre-firms-<time>.db` is written to the backups folder first, and the logs say `Firms migration done: N leads moved to firm 1, M messages kept`.

## Operations

* Logs: Railway → service → Deployments → View logs.
* Health check: `GET /health`.
* Database backup: the SQLite file is `/data/leaddesk.db` on the volume (Railway → Volume → backups).
* Rotate the Meta token or any secret: change the variable → Railway redeploys automatically.
* Cost: Hobby plan (~$5/month) is enough; the app uses ~100 MB RAM.
