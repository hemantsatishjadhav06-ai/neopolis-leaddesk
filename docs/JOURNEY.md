# The 13-day WhatsApp journey

Six Meta **marketing templates**, sent only to leads who have not replied yet. The moment a lead replies (or taps a button), the journey stops and the AI concierge takes over. Anyone who says STOP / Not interested is opted out permanently. Sends happen 9 AM–8 PM IST. Footer on every message: *Neopolis Infra • Reply STOP to opt out*

The messages are written to get a reply: short, one question each, and answerable with one tap. A button tap counts as a reply, so it opens the 24-hour window and the AI picks up the conversation from there.

| Day | Template | Asks | Buttons |
|---|---|---|---|
| 0 | `neopolis_v2_d0_hello` | Reminds them of their enquiry; may we send 3 options? | Send me options · Call me |
| 2 | `neopolis_v2_d2_area` | Which area? | Kokapet / Narsingi · Financial District · Tellapur / Kollur |
| 4 | `neopolis_v2_d4_budget` | Which budget? | Under ₹1.5 Cr · ₹1.5 – 2.5 Cr · ₹2.5 Cr+ |
| 7 | `neopolis_v2_d7_visit` | Would they like a site visit? | Book a site visit · Call me first · Not right now |
| 10 | `neopolis_v2_d10_help` | What is holding them back? | Home loan help · I'm an NRI · Talk to a consultant |
| 13 | `neopolis_v2_d13_last` | Last message: shortlist, later, or stop | Send a shortlist · Maybe later · Not interested |

Cost: about ₹0.86 per marketing message in India → at most ₹5.20 per lead who never replies (most stop earlier).

## Day 0 — neopolis_v2_d0_hello

> Hi {{1}}, this is Neopolis Infra 👋 You recently enquired about a home in West Hyderabad.
>
> We have title-verified 3 & 4 BHK homes in Kokapet, Narsingi, Tellapur, Kollur and the Financial District, typically 8–14% below resale with zero brokerage.
>
> Shall I send you 3 options that fit your budget?

**Buttons:** `Send me options, Call me`

## Day 2 — neopolis_v2_d2_area

> Hi {{1}}, which area would you like to live in? I'll shortlist homes there for you.
>
> • Kokapet: premium high-rises
> • Financial District, Narsingi, Tellapur, Manchirevula: mid-range
> • Kollur: the value entry point, from under ₹1 Cr
>
> Tap an area below, or reply with another one.

**Buttons:** `Kokapet / Narsingi, Financial District, Tellapur / Kollur`

## Day 4 — neopolis_v2_d4_budget

> Hi {{1}}, what budget are you comfortable with? Then we'll only send homes that fit.
>
> Our options run from under ₹1 Cr to ₹3.5 Cr+, both ready-to-move and under construction.

**Buttons:** `Under ₹1.5 Cr, ₹1.5 – 2.5 Cr, ₹2.5 Cr+`

## Day 7 — neopolis_v2_d7_visit

> Hi {{1}}, would you like to see a few homes in person? 🏡
>
> A consultant will show you around, with no obligation. Visits run every day, 9 AM to 9 PM. Tap below, or reply with a day and time that suits you.

**Buttons:** `Book a site visit, Call me first, Not right now`

## Day 10 — neopolis_v2_d10_help

> Hi {{1}}, is something holding you back? We can usually help:
>
> • Home loans: possible in most cases
> • NRI buyers: a fully remote process
> • Paperwork: we handle pricing, agreements and registration
>
> What would help you most?

**Buttons:** `Home loan help, I'm an NRI, Talk to a consultant`

## Day 13 — neopolis_v2_d13_last

> Hi {{1}}, this is my last message for now.
>
> If you're still looking for a home in West Hyderabad, tap below and I'll send you a shortlist today. If the timing isn't right, no problem, just reply whenever you're ready 🙏

**Buttons:** `Send a shortlist, Maybe later, Not interested`

_{{1}} is replaced with the lead's first name from the sheet ("there" when it is missing). "Not interested" matches an opt-out keyword, so tapping it opts the lead out. The button lines above are written exactly as the Settings editor expects them (comma separated), so button labels must never contain a comma._

## Switching a live deployment to these messages

The journey a running LeadDesk uses is stored in its database (Settings → Outreach), not taken from this file, so the new text has to be entered there. Meta has to approve every new template name before it can be sent:

1. **Settings → Outreach:** set **Send mode** to **Off** and save, so nothing goes out while the new templates are in review.
2. In **The journey**, replace each step's template name, text and buttons with the ones above (day numbers stay the same), and save.
3. Click **Submit templates to Meta**. Each step shows PENDING, then APPROVED, usually within minutes to a few hours.
4. Once all six show **APPROVED**, set **Send mode** back to **Live**.

Leads keep their place in the journey: someone who already received Day 0 gets the new Day 2 next.

Builds that include the template-approval check skip any step whose template is not APPROVED yet (Settings shows "waiting for Meta to approve …"), so step 1 is a safety net there. Older builds send anyway, and every send fails until Meta approves, using up each due lead's send attempts. On an older build, step 1 is required.
