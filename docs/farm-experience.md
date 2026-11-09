# Farm Experience

Customers book a visit to the MandiMangoes farm: they book **250 kg or more** of one mango
variety on a visit date **without paying**, stay at the farmhouse with meals, harvest and weigh
their mangoes with the farm team, and **pay after picking** for the kilograms accepted. Packing
starts once the bill is paid. Staff run every booking from the
panel under **Bulk Orders → Farm Experience Bookings**.

Everything is behind the switch `FARM_EXPERIENCE` (off by default). With it off, the shop
shows no farm card or pages, the panel shows no farm screens, and every farm route answers
404 (`FEATURE_OFF`). Turning it on still shows nothing bookable until a manager fills in the
farm settings and presses **Open bookings**.

## Rules (and where they are enforced)

| Rule | Where |
| --- | --- |
| Minimum 250 kg of one variety per booking, whole kilograms. A fixed business rule, not a setting. | `MIN_KG` in `mango-api/src/farm/settings.js`, checked on every quote and booking |
| No maximum except what is left of that variety's bookable kg on that day. | `reserveKg` in `farm/bookings.js` (one conditional `UPDATE` on `farm_harvest`) |
| No guest limit. A group larger than the farmhouse is flagged **Large group** and goes to a manager, who approves or proposes an alternative the customer accepts or declines. | `createBooking`, `approveHospitality`, `proposeAlternative`, `answerAlternative` |
| The price comes from the server only: the variety's price per kg, or its tier for that many kg. | `priceFor` in `farm/rules.js` |
| Nothing is paid at booking. The booking holds its kilograms on that day straight away. | `createBooking` |
| One customer can hold at most `maxOpenBookings` (default 2) upcoming visits at a time, so nobody ties up a day's fruit for free. | `TOO_MANY_FARM_BOOKINGS` in `createBooking` |
| A booking is never confirmed automatically: it waits in **Stay to arrange** until a manager approves the stay. | `HOSPITALITY_REVIEW` status |
| The bill comes after weighing: kilograms accepted up to the booked amount at the booking price, kilograms above it at the farm's extra price per kg (or the booking price when none is set). | `billFor` in `farm/rules.js`, `issueBill` |
| The bill is paid online (Razorpay), or a manager records a payment taken at the farm (UPI, card, cash, bank transfer, with a reference; step-up). Packing starts only once it is paid, and a visit can't be completed unpaid. | `processFarmPayment`, `recordPayment`, `staffMove` |
| Weights are fixed once billed. A corrected bill replaces the open one; a payment for the old bill, or a second payment, is refunded in full. | `recordHarvest` (`BILL_MADE`), `issueBill`, `OVERPAID` refunds |
| Transport is promised only when **Transport is included** is ticked; otherwise the shop says it is not included. | Farm settings, shop landing page and summary |
| Nothing about the farm is made up: empty fields show "our team will confirm", and bookings can't open while anything customers must read is missing. | `problems()` in `farm/settings.js` |

## Money and refunds

Customers pay only after picking (the owner's rule, 2026-11-09), so:

- **Cancelling before the visit costs nothing and refunds nothing.** At least `cancelDays`
  (default 7) before, the customer cancels at once; closer than that, or once preparations
  started, it becomes a request a manager decides. A manager can always cancel before the visit.
- **No-show:** nothing was paid, so nothing is refunded; the kilograms go back.
- **Fewer mangoes than booked:** the bill is for what was accepted, so there is no shortfall refund.
- **More mangoes than booked:** they are on the same bill, at the extra price per kg.
- **Paid twice, or paid an old bill:** that payment goes back in full (`OVERPAID`), through
  Razorpay with the same lease and back-off as order refunds. One that gives up can be settled
  by a manager with a payment reference (step-up).

The risk: with nothing paid up front, a group can book and not come. The open-bookings cap
limits how much fruit one customer can hold. A deposit at booking would cut this further, but
is not built (it would change the owner's rule).

## Statuses

(booked) `HOSPITALITY_REVIEW` → (stay approved) `CONFIRMED` → `PREPARING` → `READY_FOR_VISIT` →
(check-in) `CHECKED_IN` → `HARVESTING` → `WEIGHING` → (bill sent) `PAYMENT_DUE` → (paid)
`PACKING` → `COMPLETED`.

Off the main line:

- `CANCELLED`: by the customer or a manager, before the visit.
- `NO_SHOW`: the group did not come (a manager marks it on or after the visit day).

Every change is a row in `farm_booking_events` (who, when, from, to, detail), shown as the
booking's History in the panel. Staff can only make the moves in `STAFF_MOVES`
(`farm/rules.js`); the bill, payment, cancel, check-in and date moves have their own routes.

## Safety

- **Concurrency:** bookings take kilograms with one conditional `UPDATE … WHERE bookable_kg - reserved_kg >= kg`. The day row is locked (`FOR UPDATE`) for the visit cap, and the customer row for the open-bookings cap. Booking changes lock the booking row.
- **Idempotency:** `POST /v1/farm-bookings` needs an `Idempotency-Key`; a retry returns the same booking.
- **Payments:** each bill's Razorpay order is one `farm_booking_payments` row (`ONLINE`). Payment status comes only from a verified signature, the webhook (deduped in `webhook_events`) or reconcile, never from the shop. The amount and currency are checked against the row, and only the current bill's amount pays it. A payment taken at the farm is a `RECORDED` row with its method, reference and the manager who recorded it.
- **Step-up:** recording a payment taken at the farm, settling a refund, variety prices and farm settings ask the manager to confirm it is them (`src/admin/policy.js`).
- **Roles:** managers do everything. Operators can view and work bookings, add notes, assign rooms, move statuses, record the harvest, send the bill and check guests in. Recording a payment, cancelling, moving dates, no-shows, reports and the CSV are managers only. Customers see only their own bookings.

## API

Customer API (`/v1`, signed-in customer unless marked public):

| Route | Purpose |
| --- | --- |
| `GET /farm-experience` (public) | Farm details, policies, FAQs and varieties |
| `GET /farm-experience/dates` (public) | Dates with enough kg of a variety |
| `POST /farm-experience/quote` (public) | Server price for a variety and kg |
| `POST /farm-bookings` | Create a booking, nothing paid (Idempotency-Key) |
| `GET /farm-bookings` | List my bookings |
| `GET /farm-bookings/:id` | One of my bookings |
| `GET /farm-bookings/:id/qr.svg` | Check-in QR |
| `POST /farm-bookings/:id/pay` | Start (or pick up) the online payment of the bill |
| `POST /farm-bookings/:id/verify-payment` | Verify a Razorpay payment signature |
| `POST /farm-bookings/:id/cancel` | Cancel, or ask to cancel |
| `POST /farm-bookings/:id/reschedule` | Move the visit date, or ask to |
| `POST /farm-bookings/:id/hospitality` | Accept or decline a proposed alternative |

The admin API is under `/admin/v1/farm/…`: overview, bookings (list, detail, patch, notes,
hospitality, rooms, status, harvest, bill, record payment, move, cancel, decline, no-show),
refund settle, check-in, calendar (days), harvest, varieties, rooms, settings, reports and the
CSV. The full list with roles is in `docs/authorization-matrix.md`.

## Data

Migration `054_farm_experience.sql` adds these tables:

- `farm_settings`
- `farm_varieties`
- `farm_days`
- `farm_harvest`
- `farm_rooms`
- `farm_bookings`
- `farm_booking_payments`
- `farm_refunds`
- `farm_room_allocations`
- `farm_booking_events`
- `farm_booking_notes`

It also adds farm columns to `notifications`. Migration `055` validates the notification
checks it changed. Nothing existing is dropped or rewritten.

## Configuration

| Env | Default | What |
| --- | --- | --- |
| `FARM_EXPERIENCE` | off | Turns the whole feature on (shop, panel, API). |
| `WHATSAPP_FARM_UPDATES` | off | Sends `FARM_BOOKING_UPDATE` to customers and `FARM_TEAM_ALERT` to the team. Both templates need Meta's approval first (`docs/whatsapp/TEMPLATES.md`). Off: nothing is sent, and the shop and panel show the same status. |
| `FARM_ALERT_PHONES` | empty | Comma-separated Indian mobiles for team alerts. |

In the panel, set up the following:

- **Farm settings:** the farm's name, place, contact, arrival, check-in and check-out times, the stay, meals, transport, policies, FAQs, the season, notice days, upcoming visits per customer, cancel and move days, usual nights, and an optional extra-kg price.
- **Harvest stock:** varieties with their price per kg and tiers, and the bookable kg per day.
- **Calendar:** which days are open, and an optional cap on visits per day.
- **Rooms:** the farmhouse rooms, how many each sleeps, and extra beds.

## Rollout

1. Deploy with `FARM_EXPERIENCE` off. Migrations 054 and 055 run, and nothing changes for customers.
2. On staging, turn `FARM_EXPERIENCE` on. Fill in the farm settings with the real farm's details (never sample text), add varieties, harvest kg, open days and rooms.
3. Run one booking end to end in Razorpay test mode: book, approve the stay, check in, weigh, send the bill, pay it, pack, complete. Also record one payment taken at the farm, and cancel one booking.
4. Get Meta approval for the two templates, then turn on `WHATSAPP_FARM_UPDATES` and set `FARM_ALERT_PHONES`.
5. In production, turn on `FARM_EXPERIENCE`, check the shop shows the real details, then press **Open bookings**.

## Rollback

- **Fast:** in Farm settings, press **Close bookings**. No new bookings are taken, and existing ones carry on.
- **Hide the feature:** turn `FARM_EXPERIENCE` off. The shop and panel hide it and the routes answer 404. Bookings and bills stay in the database untouched. Refunds already queued keep going out, because the refund loop runs whatever the switch says.
- **Code:** reverting the change leaves the farm tables in place (no destructive migration). They are unused while the code is gone.

## Tests

- **API:** `mango-api/test/farm-experience.test.js` covers the rules, the bill, the open-bookings cap, concurrency, paying the bill (webhooks, once however often), recorded payments, refunds of double or old-bill payments, the state machine and permissions. Farm routes are also in the step-up, isolation, auth-matrix and WhatsApp suites.
- **Shop and panel together:** `customer-app/tests/farm.spec.ts`, against the real API with `FARM_EXPERIENCE` on. A customer books 300 kg in six steps without paying; in the panel a manager assigns a room, approves the stay, checks the group in, records 305 kg accepted and sends the bill; the customer pays it; the manager completes the visit.
