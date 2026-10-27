# Firms: more than one business in one LeadDesk

One LeadDesk can run several businesses ("firms"), each with its own WhatsApp number. The team switches between them with the **Firm** selector at the top left.

| Belongs to each firm | Shared by every firm |
|---|---|
| WhatsApp number (sender) and its inbox | Team logins and roles |
| Google Sheet (where its contacts come from) | AI model, send window, pacing (until a firm saves its own) |
| AI knowledge (system prompt), hand-off and fallback text | The Meta app, webhook URL and access token |
| Journey / bulk messages and their Meta templates | Daily spend ceilings (`SEND_DAILY_CAP`, `AI_DAILY_CAP`) |
| Send mode, reply mode, test numbers | Backups |

The first firm (Neopolis Infra) is the one the deployment was built for. Its number, WABA and sheet still come from the Railway variables (`PHONE_NUMBER_ID`, `WABA_ID`, `SPREADSHEET_ID` …), so nothing about it changed.

A new firm starts with **send mode OFF** and **reply mode TEST**. It never inherits the first firm's modes, test numbers or messages. And it never sends from another firm's number: until its own number is registered, every send for it is blocked.

## Adding a firm

Either **Settings → Firms → + Add firm** (name, WhatsApp number, optional sheet link), or the `FIRMS` variable in Railway, read at every boot:

```
FIRMS=[{"name":"MoreSpace","number":"7075168306","sheet":"https://docs.google.com/spreadsheets/d/1rAsfjBqTsV0O4NdI126vQkAvhYtUUB-83jyTnEBBzz4/edit"}]
```

`FIRMS` only adds. A firm that already exists is left as the team edited it, and its sheet is connected once: a sheet someone disconnects later stays disconnected.

## The contact sheet

Any sheet with a name column and a number column works, e.g. **Name** | **Number**. Recognised number headers: `whatsapp_number`, `phone_number`, `phone`, `mobile`, `whatsapp`, `number`, `mobile_number`, `contact_number`. Numbers can be typed any way (`7075100001`, `+91 70751 00001`, `07075100001`); 10-digit numbers are read as Indian (+91). Rows without a usable number are listed under Settings → Google Sheet.

The sheet is imported every 10 minutes through its link, so it must be shared as **Anyone with the link → Viewer**. Anyone who has that link can read the names and numbers, and with **Editor** they can also change them. Nothing is written back to this sheet.

## Registering the firm's WhatsApp number (once)

With the firm selected, open **Settings → WhatsApp → Register … number (wizard)**. The number and display name are already filled in.

1. The number must **not** be active in the WhatsApp or WhatsApp Business app. Delete that account in the app first.
2. **1. Add**: adds it to the WhatsApp Business Account and links it to the firm.
3. **2. Send SMS code**: Meta texts a 6-digit code to that phone.
4. **3. Verify**: enter the code.
5. **4. Register**: choose a 6-digit PIN and keep it safe.

If the number was already added in WhatsApp Manager, it appears under *Numbers on this account*: click **Use for <firm>**. Messages to the number arrive through the same webhook and land in that firm's inbox. Replies and journey messages go out from that number only.

Meta reviews the display name. A name that doesn't match the business on the WhatsApp Business Account can be rejected; you'll see Meta's answer in the wizard.

## Going live

1. **Settings → AI concierge**: check what the AI knows about the firm.
2. **Settings → Outreach**: review the journey, click **Submit templates to Meta**, and wait until each template is APPROVED. A step is held until Meta approves its template.
3. Put your own number in *Test numbers*, set **Send mode: Test**, and press **Run now**.
4. Switch **Send mode** and **Reply mode** to **Live**.

## MoreSpace's starting messages

Written only from what morespace's website says (no prices, results or client names). Editable under Settings → Outreach.

| Day | Template | Buttons |
|---|---|---|
| 0 | `morespace_d0_intro` | Yes, tell me more · Not now |
| 3 | `morespace_d3_focus` | More leads · Software or tools · AI automation |
| 7 | `morespace_d7_last` | Book a call · Maybe later · Not interested |

Footer: *MoreSpace • Reply STOP to opt out*. A reply or a button tap stops the journey and the AI answers. "Not interested" opts the person out.
