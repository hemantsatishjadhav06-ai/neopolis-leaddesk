# The 13-day WhatsApp journey

Six Meta **marketing templates**, sent only to leads who have not replied yet. The moment a lead replies (or taps a button), the journey stops and the AI concierge takes over. Anyone who says STOP / Not interested is opted out permanently. Sends happen 9 AM–8 PM IST. Footer on every message: *Neopolis Infra • Reply STOP to opt out*

The messages are written to get a reply: short, one question each, answerable with one tap. A button tap counts as a reply, so it opens the 24-hour window and the AI picks up the conversation from there.

They create urgency from two facts only: landlord-share units are a fixed allocation in each tower, and the 8–14% saving against resale is gone once they are booked (₹16–28 lakh on a ₹2 Cr home is that range applied to ₹2 Cr). There are no invented stock counts, deadlines or "other buyers are booking" claims. False urgency is a prohibited dark pattern under India's 2023 guidelines, and Meta reviews templates for misleading claims. If you add urgency of your own, keep it true.

| Day | Template | Asks | Buttons |
|---|---|---|---|
| 0 | `neopolis_v3_d0_hello` | Reminds them of their enquiry and the saving; send what's still available? | Send me options · Call me |
| 2 | `neopolis_v3_d2_area` | Which area? (best units go first) | Kokapet / Narsingi · Financial District · Tellapur / Kollur |
| 4 | `neopolis_v3_d4_budget` | Which budget? (units in range before they're booked) | Under ₹1.5 Cr · ₹1.5 – 2.5 Cr · ₹2.5 Cr+ |
| 7 | `neopolis_v3_d7_visit` | Site visit this weekend? | Book this weekend · Call me first · Not right now |
| 10 | `neopolis_v3_d10_help` | What is holding them back? | Home loan help · I'm an NRI · Talk to a consultant |
| 13 | `neopolis_v3_d13_last` | Last message: the saving won't last | Send a shortlist · Maybe later · Not interested |

Cost: about ₹0.86 per marketing message in India → at most ₹5.20 per lead who never replies (most stop earlier).

## Day 0 — neopolis_v3_d0_hello

> Hi {{1}}, this is Neopolis Infra 👋 You recently enquired about a home in West Hyderabad.
>
> We sell landlord-share 3 & 4 BHK homes: same towers as the developer, typically 8–14% below resale, zero brokerage. On a ₹2 Cr home that is roughly ₹16–28 lakh saved.
>
> Each tower has a limited number of these units. Shall I send you the ones still available?

**Buttons:** `Send me options, Call me`

## Day 2 — neopolis_v3_d2_area

> Hi {{1}}, the best landlord-share units are usually the first to be booked, so let's start with your area. Which one suits you?
>
> • Kokapet: premium high-rises
> • Financial District, Narsingi, Tellapur, Manchirevula: mid-range
> • Kollur: the value entry point, from under ₹1 Cr

**Buttons:** `Kokapet / Narsingi, Financial District, Tellapur / Kollur`

## Day 4 — neopolis_v3_d4_budget

> Hi {{1}}, what budget are you comfortable with? Share it and I'll send you the units in that range before they're booked.
>
> Options run from under ₹1 Cr to ₹3.5 Cr+, ready-to-move and under construction.

**Buttons:** `Under ₹1.5 Cr, ₹1.5 – 2.5 Cr, ₹2.5 Cr+`

## Day 7 — neopolis_v3_d7_visit

> Hi {{1}}, the buyers who get the best landlord-share units are the ones who see them first 🏡
>
> Visit any day, 9 AM to 9 PM, with no obligation. A consultant shows you the units and the price gap against resale on the spot. Shall I book you in this weekend?

**Buttons:** `Book this weekend, Call me first, Not right now`

## Day 10 — neopolis_v3_d10_help

> Hi {{1}}, don't let paperwork cost you a good unit. We can usually help:
>
> • Home loans: possible in most cases
> • NRI buyers: a fully remote process
> • Pricing, agreements and registration: handled end-to-end
>
> What would help you most?

**Buttons:** `Home loan help, I'm an NRI, Talk to a consultant`

## Day 13 — neopolis_v3_d13_last

> Hi {{1}}, this is my last message for now.
>
> Landlord-share units are limited, and once a tower's are booked, that 8–14% saving is gone. If you'd still like to see what's available, tap below and I'll send a shortlist today 🙏

**Buttons:** `Send a shortlist, Maybe later, Not interested`

_{{1}} is replaced with the lead's first name from the sheet ("there" when it is missing). "Not interested" matches an opt-out keyword, so tapping it opts the lead out. Button lines are written exactly as the Settings editor expects them (comma separated), so a button label must never contain a comma._

## Switching a live deployment to these messages

The journey a running LeadDesk uses is stored in its database (Settings → Outreach), not taken from this file:

1. **Settings → Outreach → The journey:** click **Load recommended messages**, check the six steps, then click **Submit templates to Meta** (it saves first).
2. Each step shows PENDING, then APPROVED, usually within minutes to a few hours. Until a step's template is APPROVED, leads due for that step wait; Settings shows "waiting for Meta to approve …". Nothing fails, and no send attempts are used up.

Leads keep their place in the journey: someone who already received Day 0 gets the new Day 2 next.

On a build older than the template-approval check, set **Send mode** to **Off** while the templates are in review. Without it, every send fails until Meta approves and uses up each due lead's send attempts.

## Pacing

The automatic run sends at most **2 journey messages per run**, runs **20 minutes** apart, with at most **40 per day** (from midnight IST). Change these in Settings → Outreach; 0 means no limit. **Run now** skips the 20-minute spacing but not the daily cap.
