# Connecting the Google Sheet (2 minutes, no Google Cloud project)

LeadDesk reads new leads from your sheet and writes back `lead_status`, one new `last_reply` column, and a **Client Replies** tab. It never touches any other column and never touches the LinkedIn tab.

The connector is a tiny **Apps Script** that runs inside your own spreadsheet with your own Google account's permission.

## Steps (signed in as the sheet's owner, you@example.com)

1. Open the leads spreadsheet → menu **Extensions → Apps Script**. A code editor opens with an empty `Code.gs`.
2. Delete whatever is there and paste the whole content of **`apps-script/Code.gs`** from this package.
3. On the line `var SECRET = 'REPLACE_WITH_SECRET';` put a long random secret (LeadDesk shows a generated one under **Settings → Google Sheet**). Keep it — you'll need it in step 6.
4. Click **Deploy → New deployment** → click the gear next to "Select type" → **Web app**.
   * Description: `LeadDesk connector`
   * Execute as: **Me**
   * Who has access: **Anyone** (the secret protects it)
   * **Deploy**. Google will ask you to authorise the script — choose your account → *Advanced → Go to … (unsafe)* → **Allow** (it's your own script accessing your own sheet).
5. Copy the **Web app URL** (ends in `/exec`).
6. In Railway (or `.env`) set:
   * `SHEETS_APPS_SCRIPT_URL` = that URL
   * `SHEETS_APPS_SCRIPT_SECRET` = the secret from step 3
   * `SPREADSHEET_ID` = `YOUR_SHEET_ID_HERE`
   and redeploy.
7. LeadDesk → **Settings → Google Sheet → Test connection** (shows the sheet name and tabs) → **Import now**.

If you ever edit the script: **Deploy → Manage deployments → ✎ → Version: New version → Deploy** (the URL stays the same).

## Which tabs are imported

Every tab that looks like a lead-form export is imported: a `whatsapp_number` or `phone_number` column, a `full_name` column, and `created_time` or `lead_status`. So a new ad form landing in its own tab (like *Sheet6*) is picked up automatically. Notes tabs (*visits list*, with NAME / NUMBER), the **Client Replies** log and stray sheets are skipped. To import only specific tabs, list them under **Settings → Google Sheet → Leads tab name**, e.g. `02-08-2026, Sheet6`.

* A number that appears in several rows or tabs is imported once (the first row wins).
* A new lead whose row already carries a "not interested" / "DND" note from the sales team is imported **paused**, so the journey never messages them. Resume them from **Leads** if that note was wrong.
* With the read-only **sheet link** connection, LeadDesk downloads the whole workbook (one request), so the tab that happened to be open when the link was copied no longer matters.

## What it does exactly

| Operation | Effect on the sheet |
|---|---|
| `ping` | Lists the tabs; LeadDesk then reads each one (`readLeads`) and keeps the leads tabs (see above). Read-only. |
| `readLeads` | Reads one tab. Read-only. |
| `updateRow` | Writes `lead_status` on that row; writes `last_reply` — the column is created once at the far right if it doesn't exist. |
| `appendReply` | Appends one row to **Client Replies** (created on first use): timestamp, whatsapp_number, full_name, message, ai_reply, link to the lead's row, link to the chat in LeadDesk. |

Alternative: a Google **service account** also works (`GOOGLE_SERVICE_ACCOUNT_B64` + share the sheet with its email), if your IT team prefers that.
