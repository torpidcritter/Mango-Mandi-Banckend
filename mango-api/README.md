# mango-api

The MandiMangoes backend: the `/admin/v1` API the Mango Ops panel uses, the `/v1`
storefront API, Razorpay payments, and the engine that decides which boxes can be sold
as raw, semi-ripe or ripe on each delivery date.

Node 22, Express 4, PostgreSQL 16. One process, one database; stock holds, payment
confirmation and allocation all commit in the same Postgres transaction.

## Run it locally

```bash
cd mango-api
npm ci
# Postgres with user/password mango, database mango (docker compose up db works too)
COOKIE_SECURE=false ENABLE_DEV_ROUTES=true npm run dev
```

On start it migrates, seeds products (Alphonso and Badami, 3 kg and 5 kg), Bengaluru
pincodes and four staff logins (`manager@mandimangoes.test` / `manager123`,
`ops@mandimangoes.test` / `operator123`, `packer@mandimangoes.test` / `packer123`, `qc@mandimangoes.test` / `qc123`;
not created in production), plus a spread of demo
batches when the database is empty. Point the panel at it with
`VITE_API_URL=http://localhost:3000`.

`docker compose up --build` starts Postgres and the API together. Settings are in
[`.env.example`](.env.example); in production the API refuses to start with a weak
`JWT_SECRET`, the dev webhook secret, or `COOKIE_SECURE=false`.

## Login codes by SMS (Jio)

Customers sign in with a 6-digit code. With `SMS_PROVIDER=jio` the code goes out
through the Jio SMS gateway. Production needs Jio, or WhatsApp with
`OTP_DEFAULT_CHANNEL=whatsapp` (codes by WhatsApp only, e.g. before DLT is approved). Set `JIO_SMS_URL`,
`JIO_SMS_API_KEY`, and the DLT registration (`JIO_SMS_SENDER_ID`, `JIO_SMS_TEMPLATE_ID`,
`JIO_SMS_ENTITY_ID`). `JIO_SMS_TEXT` must match the registered template exactly, with
`{code}` where the code goes. The request body is in [`src/sms.js`](src/sms.js); check it
against your Jio account's API docs before going live: **the request format in the code is
not yet verified against Jio's documentation** (remaining blocker OPS-03b). A reply counts as sent only
when the field `JIO_SMS_SUCCESS_PATH` holds one of `JIO_SMS_SUCCESS_VALUES`, both copied from
Jio's docs; anything else (including a bare HTTP 200) counts as not sent and the code goes by
WhatsApp instead. Outside production the default
`SMS_PROVIDER=log` returns the code as `devCode` (unless `OTP_CODE_IN_RESPONSE=false`); it is
written to the log only with `LOG_OTP_CODES=true` (for a preview, where `devCode` is off;
production refuses it).

If the SMS send fails and WhatsApp is set up (`WHATSAPP_PROVIDER=meta`), the code goes out
on WhatsApp instead, as the authentication template `mandi_login_code` (code in the body and
in the copy-code button). The app can also ask for WhatsApp first with
`{"channel":"whatsapp"}` on `/v1/auth/otp/request`; the response says which channel was
used. Each fallback counts in `mango_otp_fallbacks_total`. If neither works the request fails
with `OTP_NOT_SENT`.

## WhatsApp order updates

Each order step queues a WhatsApp message in the `notifications` table, in the same
transaction as the step, so an update is never lost or sent for a change that rolled
back. The maintenance loop sends them, retrying after 1, 5, 15, 60 and 180 minutes, then
marks them `FAILED`; anything still unsent after 24 hours is `SKIPPED` (old news). Staff
see each message and its state on the order page.

With `WHATSAPP_PROVIDER=meta` messages go through the WhatsApp Cloud API: set
`WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. Every message is an approved template
named `WHATSAPP_TEMPLATE_PREFIX` + kind (default prefix `mandi_`), in `WHATSAPP_LANGUAGE`:

| Template | Sent when | Body variables |
|----------|-----------|----------------|
| `mandi_order_confirmed` | payment confirms the order | name, order number, date ("Fri, 16 Oct"), slot ("7 AM to 11 AM") |
| `mandi_replacement_confirmed` | a free replacement is booked | same as above |
| `mandi_out_for_delivery` | the order leaves for delivery | name, order number, slot, 4-digit delivery code ("Give the rider code {{4}}") |
| `mandi_delivered` | delivered | name, order number |
| `mandi_delivery_failed` | a delivery is missed and retried | name, order number, retry date |
| `mandi_date_moved` | staff move the order to another date (one order, or a whole day), or a late payment lands on the next date with stock | name, order number, new date, slot |
| `mandi_cancelled` | a confirmed order is cancelled (unpaid holds send nothing) | name, order number |
| `mandi_login_code` | login code, only when SMS fails or the app asks for WhatsApp (authentication category) | code |
| `mandi_refunded` | Razorpay confirms a customer-cancel refund (order or preorder) | name, order number, amount ("Rs 1,899") |
| `mandi_preorder_booked` | a preorder is paid | name, preorder number, boxes ("2 × Alphonso 3kg Box"), week ("the week of Mon, 1 Mar") |
| `mandi_preorder_spot_open` | a waitlist spot opens | name, boxes, week, payment link |
| `mandi_preorder_moved` | a week passed without stock, so the preorder moved a week | name, preorder number, boxes, new week |
| `mandi_review_request` | about a day after delivery, once per order, if nothing on it is reviewed yet (marketing category). **Needs Meta approval; only sent once `WHATSAPP_REVIEW_REQUESTS=true`** | name, order number |
| `mandi_ripeness_guide` | a minute after `order_confirmed` or `replacement_confirmed`, only when a box arrives raw or semi-ripe (utility) | name, order number, when each box is ready ("Alphonso 3kg Box (raw): ready around Mon, 19 Oct"), storage tip |
| `mandi_back_in_stock` | a box the customer asked about is in stock again (they tapped "Tell me when it's back") | name, box ("Alphonso 3kg Box (ripe)"), first day ("Fri, 16 Oct"), shop link |
| `mandi_reorder_reminder` | a week after a delivery, only for customers who turned reminders on, between 10 AM and 7 PM, not if they ordered since (marketing) | name, box they had, shop link |
| `mandi_claim_received` | a customer reports a problem with a delivered order (utility). **New: needs Meta approval; only sent once `WHATSAPP_CLAIM_UPDATES=true`** | name, order number; "Open order" URL button |
| `mandi_claim_rejected` | staff reject a claim; a replacement sends `mandi_replacement_confirmed` instead (utility). **New: needs Meta approval; only sent once `WHATSAPP_CLAIM_UPDATES=true`** | name, order number, the reason staff gave (shown to the customer); "Open order" URL button |

An order without a slot says "during the day" in place of the slot.

A payment that lands after the hold ran out, when no date has stock, confirms the order at
risk. Its `order_confirmed` is held back (shown on the order page as not sent) rather than
promise a date the shop can't keep, and the shop's order page says we're finding stock. When
stock is found the confirmation goes out with the real date; a manager may instead move or
cancel the order. There is no "we're finding stock" template yet: if the owner wants the
customer told straight away, a new utility template has to be approved in WhatsApp Manager first.

**"Open order" button (UX-7).** A template with this button has one URL button (index 0) of
type *dynamic URL*, `https://mandimangoes.in/orders/{{1}}` (the shop's real domain), whose
variable the API fills with the order id, so one tap opens the order to track, move, cancel or
report a problem. `mandi_claim_received` and `mandi_claim_rejected` are created with it. For
`mandi_order_confirmed`, `mandi_replacement_confirmed`, `mandi_out_for_delivery`,
`mandi_delivered`, `mandi_delivery_failed` and `mandi_date_moved` the button is a template
change that needs Meta's approval again: add it in WhatsApp Manager, wait for every one of them
to be approved, then set `WHATSAPP_ORDER_LINKS=true`. Until then the API sends them without the
button (a button variable sent to a template without one is refused by Meta). The gift
recipient's copy of `mandi_out_for_delivery` carries the button too; the order page asks them to
sign in as the buyer.

Suggested wording for the two new templates (the owner words the final text in WhatsApp
Manager): "Hi {{1}}, we have your report about order {{2}}. We will look at it and reply here
within a day." and "Hi {{1}}, we looked into your report about order {{2}} and could not offer
a replacement: {{3}}. Reply here if you would like to talk to us about it."

Word `mandi_date_moved` so it also says the customer can cancel for a full refund until the
order is packed, for example: "Hi {{1}}, order {{2}} will now arrive on {{3}}, {{4}}. If that
date doesn't suit you, cancel it in the app before it is packed for a full refund." That is
the opt-out for a late payment or a staff move to a date the customer didn't choose.

Outside production the default `WHATSAPP_PROVIDER=log` logs each message and marks it
sent. In production without a provider, messages are skipped with a warning.

## Ordering in the WhatsApp chat

Customers can order by messaging the business number. Meta posts each message to
`POST /webhooks/whatsapp` (signed with the app secret, `X-Hub-Signature-256`); Meta
checks the endpoint first with `GET /webhooks/whatsapp` and `WHATSAPP_VERIFY_TOKEN`.
The chat (`src/chat.js`) keeps one conversation per phone in `wa_sessions`:

1. menu: Order mangoes, Book ahead, My orders (send *help* for how it works)
2. pincode, then the boxes in stock for the earliest delivery date, by ripeness
3. quantity, cart, then a delivery slot when slots are on
4. address (the last one for that pincode is offered), then a summary with Pay

Pay books the order exactly like app checkout (10-minute hold, slot check) with
`channel = 'whatsapp'`, then sends the payment. With `WHATSAPP_PAYMENT_CONFIG` set (the
Razorpay payment configuration name in WhatsApp Manager) the customer pays inside
WhatsApp; otherwise they get a Razorpay payment link. Razorpay's `payment_link.paid`
webhook, Meta's payment status update, or the reconcile loop confirms the order, and
the usual WhatsApp updates follow. My orders lists recent orders and lets the customer
cancel until packing, with the full refund for a paid order. WhatsApp verifies the
phone number, so the chat needs no OTP; only Indian numbers can order. Messages are
deduplicated by id, so Meta's retries are safe.

**Book ahead** in the chat makes a preorder with the same engine as `POST /v1/preorders`
(`channel = 'whatsapp'`): pick an open week and box, the ripeness, how many, the pincode
and address, then pay by Razorpay link. A full week offers the waitlist instead (no
payment until a spot opens). Bookings show in My orders and can be cancelled there for a
full refund until packing.

## After the order: ripeness guide, alerts, reminders

- **Ripeness guide.** A minute after the confirmation, an order with a raw or semi-ripe box gets
  `mandi_ripeness_guide`: the day each box will be ready to eat (raw +5 days, semi-ripe +2 from
  the delivery date, the same days the eat-by date assumes) and how to keep them. Ripe-only orders skip it. The shop's order page shows
  the same "ready to eat around" date.
- **Back in stock.** A box sold out on every open day shows "Tell me when it's back" in the shop
  (signed in). The alert lasts 14 days, at most 10 open per customer, one per box and ripeness.
  The background loop checks open alerts every run and sends `mandi_back_in_stock` once, with
  the first day it can be delivered. Customers see and stop alerts on the Account page
  (`GET/POST/DELETE /v1/stock-alerts`).
- **Reorder reminder.** Off by default. A customer turns it on under Account > WhatsApp messages
  (`PATCH /v1/me {remindersOptIn}`). Seven days after a delivery, between 10 AM and 7 PM IST,
  they get `mandi_reorder_reminder`, unless they ordered again since. One per order.

Deleting an account cancels its alerts and turns reminders off.

## Promo codes and gifts

Managers make codes on the panel's Promos page (`/admin/v1/promos`): a percentage (with
an optional cap) or a flat amount off, a smallest order, start and end dates, total and
per-customer uses, and first-order-only. The shop sends `promoCode` with the quote; the
code is checked again, with the row locked, when the order is confirmed, and the use is
recorded. A use counts while its order is not cancelled. The discount never takes the
total below ₹1.

An order can be a gift: `gift { recipientName, recipientPhone, message }` at checkout. The
pack list marks it (no price slip, the note goes in the box) and the rider sees the
recipient's name and phone. Order updates and the delivery code still go to the buyer.

## Preorders (phase 2)

Customers book a SKU, ripeness and quantity for a delivery **week** (Monday start) before
the fruit exists, at the price of the day, and pay in full by Razorpay payment link.

- **Capacity.** Managers set boxes per SKU per week (Preorders page, or
  `PUT /admin/v1/preorder-capacity/:weekStart/:sku`). Booking takes capacity with a
  conditional `UPDATE`, so a launch-day rush can't oversell. Only weeks after the
  regular booking horizon are open.
- **Waitlist.** A full week refuses with `PREORDER_FULL`, or with `waitlist: true` joins the
  waitlist. Freed or added capacity goes to the waitlist in booking order; the promoted
  customer gets a WhatsApp message with a payment link and 12 hours to pay.
- **Holds and late payments.** An unpaid booking holds capacity for `holdMinutes`. A payment
  after the hold still books it (over capacity if need be), as for orders.
- **Allocator.** Every maintenance tick, each paid preorder whose week has reached one day
  past the regular booking horizon becomes a normal confirmed order on the first date in its
  week with stock. Preorders therefore claim stock before regular shoppers can book that
  date. The order carries the preorder's payment, and the usual WhatsApp updates follow.
  When a week passes with no stock, the preorder moves to the next week and the customer is
  told (`moved_count`); nothing is cancelled.
- **Cancel.** The customer can cancel any time before packing with a full refund, the
  same rule as orders: before conversion through `POST /v1/preorders/:id/cancel`, after it
  that call cancels the order.

## Season ops (phase 3)

- **Bulk reschedule.** `POST /admin/v1/orders/bulk-reschedule` (managers) moves every
  confirmed or processing order on `fromDate` to `toDate`, optionally only some `pincodes` or
  `orderIds`, with a `reason` that goes on each order. Send `dryRun: true` first to see what
  matches. Each order moves in its own transaction, onto `toDate` or the next open date after it
  with stock, and the customer gets `mandi_date_moved`. Orders with no stock anywhere stay put and
  come back in `notMoved` so ops can handle them. At most 500 orders per call.
- **Rider manifest.** `GET /admin/v1/manifest?date=` returns the day's run: one block per slot,
  stops by zone and pincode, each with address, phone, boxes and whether it is packed. Every
  order is prepaid, so riders collect nothing. It assumes MandiMangoes' own riders; a delivery partner
  would need an export in their format.
- **Analytics.** `GET /admin/v1/analytics?from&to` (default: the last 8 weeks to the end of this
  week) returns week-by-week sales (by delivery date), deliveries and misses, at-risk orders,
  boxes received and wasted (condemned or retired), customer cancels, refunds and claims, plus a
  per-SKU table and totals. Money is in paise.

## Proof of delivery

Riders have their own staff role, `RIDER`, which can open the Deliveries page and nothing
else. A packer, operator or manager can do the same steps.

- **Start a run.** `POST /admin/v1/manifest/dispatch` `{date, slotId}` sends every packed order
  of that slot (`slotId: null` for orders without one) out for delivery; unpacked orders are
  skipped and listed. `POST /orders/:id/dispatch` does one order, including a retry after a
  missed delivery.
- **Delivery code.** Going out for delivery gives the order a 4-digit code. The customer sees it
  in the app and in the `mandi_out_for_delivery` WhatsApp message, and reads it to the rider. A
  retry keeps the same code. Five wrong codes lock it (`CODE_LOCKED`); then the rider uses a photo.
  For a gift, the recipient gets the same message with the code (kind `GIFT_OUT_FOR_DELIVERY`,
  sent with the `mandi_out_for_delivery` template and the recipient's name), since they are the
  one at the door.
- **Delivered.** `POST /orders/:id/delivery` `{outcome: 'DELIVERED', code}`, or with
  `photoId` and `receivedBy` ("Security at the gate") when nobody can give the code. Photos are
  uploaded first as the raw body of `POST /orders/:id/delivery-photos` (JPEG, PNG or WebP, 2 MB
  at most; the panel shrinks them to about 150 KB) and kept in `delivery_photos`.
- **Photo deliveries are checked.** A delivery proven only by a photo waits in Needs attention
  (`GET /admin/v1/delivery-reviews`) until someone other than the rider marks it right, or
  doubtful with a note (`POST /admin/v1/delivery-reviews/:id {ok, note}`), which goes on the
  order history so someone calls the customer. A photo after wrong codes, or with no location,
  is flagged.
- **Missed.** `{outcome: 'FAILED', reason}` with `NOT_HOME`, `UNREACHABLE`, `WRONG_ADDRESS`,
  `REFUSED` or `OTHER` (plus a `note`), optionally a photo. The order moves to the next delivery
  day as before, with the reason on the order.
- Each attempt is a row in `delivery_attempts`, with the rider and, if the phone allows it,
  where they were. Staff moving an order to delivered from the order page is recorded as
  `staff`, with no proof. The staff order page shows every attempt and photo; the customer
  sees how it was handed over and the photo (`GET /v1/orders/:id/delivery-photo`).

## Delivery slots

Managers set up delivery windows (Planning page, or `/admin/v1/slots`), each with an
optional daily box limit. Once any slot is on, checkout requires one: the quote takes
`slotId` and refuses a full slot (`SLOT_FULL`). `GET /v1/delivery/slots` lists each
slot's remaining boxes for a date. Staff can pick a slot when moving an order. Moves
the system makes (late payments, failed-delivery retries, replacements) keep the slot
if it has room, else take the first with room, and never fail because of a slot.
Slots are switched off rather than deleted, so old orders keep theirs. The pack list
is sorted by slot.

## The rules it enforces

The two specs split the work: the technical plan fixes the API contract, and the
*Backend Architecture and Edge-Case Playbook* fixes the engine. The business rules
below override both.

- **No refunds for problems with delivered fruit, only replacements.** A claim resolves
  as `REPLACEMENT_APPROVED` (a free replacement order on the earliest date with stock) or
  `REJECTED`. Money goes back in full in two cases only: a customer cancels a paid order
  before packing, or a **manager** cancels a paid order or booking that we can't deliver
  (a short truck, a third missed delivery, an at-risk order, a crop failure for a
  booking). The panel asks the manager to confirm the refund; operators can't do it.
- **Claim limits.** A customer can raise 3 claims in 30 days from the app (then they are
  asked to message us), and an order already replaced can't be claimed again. A
  replacement needs a manager when the customer had 2 or more in 90 days, or when they
  say "not delivered" on an order their own delivery code confirmed.
- **Ripeness comes from age on the delivery date.** Day of pluck is age 0. By default
  a batch sells as raw at age 3, semi-ripe at 4–5 and ripe at 6–7. The latest QC reading
  shifts a batch by up to a day (QC'd ripe while the profile expected semi-ripe = a fast
  ripener). Nothing older than 7 days on its delivery date is sold, and batches retire
  at age 8. Physical stock needs an intake QC before it is sold; stock still in transit
  sells only for dates after its arrival, at 85% of its count.
- **Delivery dates.** Order before 18:00 IST for next-day delivery, after it for the day
  after. Closed days and per-day box limits come from the delivery calendar. Customers
  can book up to 5 days ahead.
- **Holds and FEFO.** Checkout holds stock for 10 minutes, oldest batch first, with a
  conditional `UPDATE` so two buyers can never take the same box. A database `CHECK`
  backs it up. Payment turns the hold into a commitment.
- **Rebalancing, never cancelling.** After QC, a status change, a condemned batch and
  hourly, every open order is re-checked. Stock that no longer fits is swapped to another
  batch with the same SKU and stage. What can't be swapped flags the order **at risk**
  for ops, and later rebalances fill it if stock arrives.
- **Late payments** (user decision): a payment that lands after the hold expired still
  confirms the order. If its stock is gone it moves to the next date that has stock.
- **Failed deliveries** (user decision): `DELIVERY_FAILED` reschedules the order to the
  next delivery day for a retry. If the packed boxes would pass the 7-day limit by
  then, the order is flagged at risk. After 3 missed deliveries it is not rescheduled
  on its own: the Needs attention card asks staff to call the customer, and the usual
  "we'll retry on" message is not sent.
- **Failed payment attempts** keep the hold: the customer can try again on the same
  payment page until the hold ends. Only the hold expiring cancels an unpaid order.
- **Double charges**: a second payment captured for an order or preorder that is
  already paid is refunded on its own (`duplicate_payments`); the order is untouched.
  So is a captured payment that fails the amount or currency check. Every refund the
  system sends on its own is listed in deploy/VERCEL.md ("Refunds the system sends on
  its own").
  Payment links expire 16 minutes after they are made, and the shop's payment window
  closes when the hold ends.
- **Customer cancels** are allowed until the order is packed. A paid order is refunded
  in full: the refund is requested in the cancel transaction, sent to Razorpay right
  after, and retried by the maintenance loop until it lands (it checks for an existing
  refund first, so retries never pay twice). A payment that arrives after the customer
  cancelled is refunded too, and a replayed payment can't revive the order. Staff can
  cancel an unpaid order up to out-for-delivery; a paid one needs a manager and is
  refunded in full. A payment that lands after a staff cancel is refunded, not
  revived. Boxes not yet shipped go back on the shelf.

- **Customers can move their own order** to another open day (and slot) while it is
  confirmed and not yet being packed, if that day has stock at the ripeness they chose.
  Staff can still move processing orders too.
- **Ratings**: after delivery a customer gives 1 to 5 stars and a note. Staff see it on the
  order, and Analytics shows the average and lists 1 and 2 star orders to call back.
- **Sold-out choices** in the catalogue carry `nextAvailableDate`, the next bookable day
  with stock for that box and ripeness, so the shop can offer that day instead.

All the numbers above live in the versioned `app_config` table (`GET/PUT
/admin/v1/config`). Each order records the version it was placed under.

## API

| Area | Routes |
|------|--------|
| System | `GET /health`, `GET /ready`, `GET /metrics` (optional bearer `METRICS_TOKEN`; Docker path only, 404 on Vercel) |
| Staff auth | `POST /admin/v1/auth/login`, `/refresh`, `/logout`, `GET /auth/me`. Refresh token is the httpOnly `mango_admin_rt` cookie, rotated on each use. |
| Dashboard | `GET /admin/v1/summary` (adds `atRiskOrders`), `GET /products` |
| Products (manager) | `POST /products`, `PATCH /products/:sku` (rename, reprice, `active: true` to put back on sale; the variety is fixed once a batch holds it), `DELETE /products/:sku` (deletes a never-used product, otherwise takes it off sale and keeps it for history). Starter products are seeded only into an empty database. |
| Batches | `GET/POST /batches`, `GET /batches/:id`, `PATCH /batches/:id/status`, `POST /batches/:id/qc`, `PATCH /batches/:id/lines/:lineId`, `GET /batches/:id/ledger` |
| Orders | `GET /orders` (`?status&from&to&q&atRisk&page`), `GET /orders/:id`, `PATCH /orders/:id/status`, `POST /orders/:id/allocate`, `/cancel`, `/rebalance`, `/reschedule` |
| Fulfilment | `GET /pack-list?date=`, `GET /manifest?date=` |
| Season ops | `POST /orders/bulk-reschedule` (managers), `GET /analytics?from&to` |
| Staff | `GET/POST /staff`, `PATCH/DELETE /staff/:id`, `GET /audit?staff&target&from&to&page` (all managers only) |
| Operations | `GET /attention` (loop heartbeat, failing steps, failed messages, stuck refunds, rejected webhooks), `POST /notifications/:id/retry` |
| Claims | `GET /claims`, `POST /claims/:id/review`, `POST /claims/:id/resolve` |
| Pincodes | `GET/POST /pincodes`, `PATCH/DELETE /pincodes/:pincode` |
| Rules | `GET/PUT /config`, `GET/PUT/DELETE /calendar/:date`, `GET /coverage` (sellable boxes per SKU and stage, and boxes booked per slot, for each bookable date) |
| Slots | `GET/POST /slots`, `PATCH /slots/:id` (managers only for changes) |
| Preorders | `GET /preorders?status&week`, `GET /preorder-capacity`, `PUT /preorder-capacity/:weekStart/:sku` (managers) |
| Customer auth | `POST /v1/auth/otp/request`, `/otp/verify`, `/token/refresh`, `/logout` |
| Storefront | `GET /v1/delivery/check?pincode=`, `GET /v1/delivery/slots?pincode=&delivery_date=`, `GET /v1/catalogue?pincode=&delivery_date=`, `GET/POST /v1/cart`, `DELETE /v1/cart/items/:sku` |
| Checkout | `POST /v1/checkout/quote`, `POST /v1/checkout/confirm` (requires `Idempotency-Key`) |
| Customer preorders | `GET /v1/preorders/weeks?sku=`, `POST /v1/preorders` (requires `Idempotency-Key`), `GET /v1/preorders`, `GET /v1/preorders/:id`, `POST /v1/preorders/:id/cancel` |
| Orders and claims | `GET /v1/orders`, `GET /v1/orders/:id`, `/payment-status` (asks Razorpay when an order is still unpaid a minute after checkout, at most every 30 s), `POST /v1/orders/:id/verify-payment` (Checkout's `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`: the signature is checked with the key secret, then the payment is fetched from Razorpay and applied), `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/reschedule` (confirmed orders, before packing), `PUT /v1/orders/:id/rating` (delivered orders), `GET/POST /v1/claims` |
| Saved addresses | `GET /v1/me/addresses`, `DELETE /v1/me/addresses/:id` (an order saves its address; at most five, gifts are not saved) |
| Payments | `POST /webhooks/razorpay` (HMAC-SHA256 over the raw body, deduplicated; `payment.authorized`, `payment.captured`, `payment.failed`, `payment_link.paid`, `refund.processed`, `refund.failed`, `payment.dispute.*` recorded for Needs attention; `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` is also accepted while set) |
| WhatsApp | `GET /webhooks/whatsapp` (Meta's verify handshake), `POST /webhooks/whatsapp` (signed messages and payment updates) |
| Dev only | `POST /v1/dev/pay`, `/v1/dev/mark-paid-at-gateway`, `/v1/dev/reconcile` (mounted only with `ENABLE_DEV_ROUTES=true`, outside production, with no Razorpay keys set) |

The staff routes live in one file per area under [`src/admin/`](src/admin): `auth.js` (sign-in,
`/auth/me`, `/me/*`), `reports.js` (summary, analytics, attention, audit), `products.js`,
`batches.js`, `orders.js` (with the pack list), `deliveries.js` (manifest, dispatch, riders, proof
of delivery), `promos.js`, `staff.js`, `claims.js`, `planning.js` (pincodes, rules, calendar,
slots, coverage) and `preorders.js`, with helpers more than one area uses in `shared.js`.
[`src/admin.js`](src/admin.js) only builds `/admin/v1`: the sign-in routes, then the gate
(`requireAdmin`, two-step setup, `limitByRole`, `riderScope`, the audit), then each area's
router. Manager-only routes carry `requireManager` on the route itself, which is where the role
matrix test looks for it; a new area router must be mounted after the gate.

Errors are `{ error: { code, message, requestId } }`. Admin routes are the contract in
the panel's `src/types.ts`; extra fields (`atRisk`, `atRiskReason`, `replacementFor`,
`eatBy`, `replacementOrder`, `slot`, `notifications`) are additive.

Cart lines carry a stage (`{ sku, stage, qty }`), unlike the technical plan's
`{ sku, qty }`. The same box can sell as raw on one date and ripe on another, so the
customer picks the stage.

## Background work

Every 60 seconds, on exactly one instance (a lease row in `job_leases`, so no
connection is held open for the run): reconcile pending payments with Razorpay, cancel
unpaid orders whose hold expired, send due refunds (and refunds of double charges) and
WhatsApp updates, prune expired OTPs, quotes, idempotency keys, webhooks, sessions and
rate-limit counters, and retire batches at age 8. A run has a 45-second budget (Vercel
stops functions at 60): each loop checks the time before a slow call and leaves the
rest for the next minute, and the full order re-check saves where it stopped. Each run
checks in with Sentry's cron monitor, which alerts when a minute is missed. Steps that
call Razorpay or WhatsApp each get a slice of the run (8–10 seconds), so a slow outside
service can't starve the rest, and the cheap database steps (hold sweep, batch
retirement, audit) run first. Hourly it rebalances only the open orders that are at
risk and runs the ledger audit, which checks `on_hand` against the ledger and
`held`/`committed` against the order allocations; once a day (or right after a rules
change) it rebalances every open order. Drift is logged and exported as
`mango_ledger_drift_lines`.

Transactions that hit a deadlock or serialization failure are retried twice with
jitter (`tx` in `src/db.js`), and slot capacity is locked per delivery date, so
checkouts for different days don't queue behind each other. A request that can't get
a database connection within 5 seconds answers `503 BUSY` with `Retry-After`.

Sign-in rate limits (login codes, staff passwords) are counted in Postgres so every
instance shares them. One address may ask for 5 codes an hour and 10 a day for a number
(so someone else asking for your number can't use up your allowance), a number gets at
most 16 codes a day from all addresses, and each code allows 3 tries (at most 48 guesses a
day at one number). A refused request never replaces the code already sent. Token refresh
has its own limit, counted per person rather than per address, so customers sharing a
carrier-NAT address don't sign each other out. The shop has a
daily budget (`OTP_DAILY_LIMIT`, Sentry warns at 80%) after which codes pause until
midnight IST. Numbers with no account may use only `OTP_NEW_NUMBER_SHARE` of it (60%),
so a bot flooding new numbers can't lock existing customers out. With
`TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` set, the shop must also pass a Cloudflare
Turnstile check before a code is sent. Session refresh and logout refuse requests from
other sites' origins.

Checkout and booking need an `Idempotency-Key`, scoped to the customer. A retry with the
same key and the same body gets the first answer back; the same key with a different
body is refused with `422 IDEMPOTENCY_KEY_REUSED`.

Every job is also safe if two instances ever run the loop at once. Each WhatsApp message is
claimed with `FOR UPDATE SKIP LOCKED` before it is sent, each refund is claimed with a
two-minute lease before Razorpay is called (and Razorpay gets an idempotency key), and each
Razorpay webhook event id is stored in the same transaction as its effect, so a repeat is
ignored and an out-of-order `payment.failed` never undoes a capture.

## Security and privacy notes

- **Riders' stops.** Each order can be given to a rider (`orders.rider_id`). Managers and
  operators do it on the Deliveries page, per stop or per slot (`POST /admin/v1/manifest/assign`
  `{date, riderId, orderIds?, slotId?}`; `GET /admin/v1/riders` lists riders), or when starting a
  run (`riderId` on `/manifest/dispatch`). A rider who sends out a packed stop nobody has takes
  it. Riders see only their own stops (plus how many packed ones nobody has), another rider's
  stop answers 404, and delivered stops from before today drop out of their view. Removing a
  rider puts their stops back in the pool.
- **No caching.** Every signed-in answer and every sign-in answer carries
  `Cache-Control: no-store`; photos keep their own `private` caching.
- **Sign out everywhere.** `POST /v1/me/sign-out-everywhere` (the shop's Account page) ends
  every refresh session and raises the account's `session_version`, so access tokens already
  issued stop working (at once on this instance, within 30 seconds on others).
- **Login codes.** Codes are stored as a SHA-256 of the code with a pepper: `OTP_PEPPER`, or
  `JWT_SECRET` when that is unset. Setting `OTP_PEPPER` later keeps codes already sent working
  for their five minutes. Outside production the code also comes back as `devCode` unless
  `OTP_CODE_IN_RESPONSE=false` (the local launcher's `--phone` mode sets it).
- **Turnstile.** A token counts only when Cloudflare says it passed, on one of the
  `CUSTOMER_ORIGIN` host names, for the action `otp` (the shop's widget sets it).
- **Degraded-mode answers (a known trade-off).** While the day's share of codes for new
  numbers is used up (`OTP_PAUSED`), or Cloudflare cannot be reached (`CAPTCHA_UNAVAILABLE`),
  numbers with an account still get a code and new numbers get a 503. Someone watching the
  answers during such a window can tell whether a number has an account. Answering everyone
  alike would mean either locking existing customers out during an SMS-pumping attack or a
  Cloudflare outage, or telling a new customer a code was sent when it was not. We keep
  existing customers signed in and accept the narrow oracle; it lasts only while the shop is
  under attack or Cloudflare is down, and Sentry is told when the budget runs out.
- **Logs.** Phone numbers are logged only masked (`maskPhone` in `src/logger.js`, e.g.
  `+9198*****`); phones and addresses inside logged objects are redacted, and
  `test/log-safety.test.js` fails on a logger call that passes a raw phone.
- **Photos.** Claim and delivery photos are re-encoded on upload (like review photos), so the
  phone's EXIF data (GPS, device) is not kept.
- **Constant-time checks** for the cron secret, `METRICS_TOKEN` and the WhatsApp verify token.

## Staff roles and the audit trail

Five roles: `MANAGER`, `OPERATOR`, `PACKER`, `QC` and `RIDER`. Riders only reach
their own stops (see "Riders' stops" below) on yesterday's, today's or tomorrow's run that
are packed or on the road; any other order id answers 404. With `STAFF_TWO_STEP=all` (the production default) every
staff account must use two-step sign-in; `managers` limits it to managers and operators.
Where it is required, setting it up needs a one-time setup code from a manager as well as
the password (shown once when a manager adds someone, resets their two-step sign-in, or
presses "Setup code" on the Staff page; it lasts 7 days). The first manager to set it up
needs none. Ten wrong passwords for one account in 15 minutes pause password sign-in for
that account until the 15 minutes are up (unknown emails are counted the same way);
Google sign-in still works, and a manager setting a new password lifts the pause. Managers and operators reach every
route except the manager-only ones. Every role but managers, operators included, gets an
allowlist in [`src/access.js`](src/access.js) and is refused everything else, so a new
route stays closed to them until it is added there; a test fails until each route is
either on the operator list or manager-only. Packers may only move orders through
`PROCESSING`, `PACKED`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED` and `DELIVERY_FAILED`.

Managers add, change and remove staff through `/staff`. A role change, password change,
two-step reset or removal ends that person's sessions, and their access tokens stop working
at once: every staff request checks the token's role and session version against the staff
row (cached for 5 seconds per instance). In production the first manager comes from `ADMIN_BOOTSTRAP_EMAIL` /
`ADMIN_BOOTSTRAP_PASSWORD`; on Vercel previews from `PREVIEW_ADMIN_EMAIL` /
`PREVIEW_ADMIN_PASSWORD` instead, so the production login never reaches a preview.

Staff passwords are at least 12 characters and may not be on the bundled list of common
passwords ([`src/data/common-passwords.txt`](src/data/common-passwords.txt), from SecLists,
checked ignoring case). Anyone can change their own password on the panel's Two-step sign-in
page (`POST /admin/v1/me/password` with the current one); their other sessions end. With
`STAFF_GOOGLE_HD` set (say `mandimangoes.in`), staff Google sign-in only accepts accounts of
that Google Workspace domain.

Who may call which staff route is snapshotted in
[`test/fixtures/role-policy.json`](test/fixtures/role-policy.json), one route per line, and
the role matrix test checks the code against it. A change to `src/access.js` or a new route
fails that test until the snapshot is regenerated (`UPDATE_ROLE_POLICY=1 npm test`) and the
diff is reviewed with the change.

Every successful staff change (any non-GET admin request) and every sign-in is written to
`staff_audit`: who, their role, the route, what it was done to, and the request body with
passwords and tokens removed. Read it at `GET /admin/v1/audit` or on the panel's Staff
screen.

## Operations

- **Needs attention.** The Today screen shows a card only when something is wrong: the loop
  has not run for 5 minutes, a loop step keeps failing, a WhatsApp message failed (with a
  Send again button), a refund has been stuck for 30 minutes, or a webhook was rejected.
  It reads `GET /admin/v1/attention`. Each loop step's last success and error are kept in
  `maintenance_runs`; rejected webhooks are kept in `webhook_failures` for 30 days.
- **Alerts.** On Vercel, alerts go through Sentry: the maintenance job's cron monitor, an
  uptime monitor on `/ready`, and a Sentry message (at most hourly each) for overdue
  messages or refunds, failing webhooks, a missed backup and ledger drift (see
  [deploy/VERCEL.md, Watch it](../deploy/VERCEL.md#8-watch-it)).
  **Docker path only:** [`ops/alerts.yml`](ops/alerts.yml) holds Prometheus alert rules for
  the loop stopping, failing steps, failing WhatsApp sends, webhook errors, login codes on
  fallback, ledger drift and API errors. Scrape `/metrics` with `METRICS_TOKEN` as a bearer
  token and route the alerts to the phone of whoever is on call. `/metrics` answers 404 on
  Vercel, so neither the metrics nor these rules apply there.
- **Backups.** [`ops/backup.sh`](ops/backup.sh) writes a `pg_dump` custom-format file,
  encrypted to a GPG public key (`BACKUP_GPG_PUBLIC_KEY_FILE` or `BACKUP_GPG_RECIPIENT`;
  with neither it refuses), and keeps 14 days (`RETAIN_DAYS`). `BACKUP_UPLOAD_CMD` copies
  it off the host in the same run, and `BACKUP_HEARTBEAT=true` records each outcome as the
  step `backup` in `maintenance_runs`. With `BACKUP_HEARTBEAT_EXPECTED=true` on the API
  (the Docker deploy sets both), Needs attention and the health check warn when no backup
  has succeeded for 26 hours.
  [`ops/restore-check.sh`](ops/restore-check.sh) restores a dump into a scratch database,
  prints the migrations and row counts, checks the stock ledger balances, then drops it.
  Run it weekly and after each schema change; a backup nobody has restored is a guess.
  The nightly GitHub workflow [`backup.yml`](../.github/workflows/backup.yml) runs it for Neon.
  That workflow fails (red, with an email) when its secrets are missing; a copy with no
  production database sets the repository variable `BACKUP_DISABLED=true` instead. Its
  last step records the heartbeat with [`ops/backup-heartbeat.sh`](ops/backup-heartbeat.sh)
  over `BACKUP_HEARTBEAT_DATABASE_URL`, a role that may write only that record (grants in
  the script and in [deploy/VERCEL.md](../deploy/VERCEL.md#backups-and-restore-drill));
  with `BACKUP_HEARTBEAT_EXPECTED=true` on Vercel a missed backup warns as on Docker.
- **Ready.** `GET /ready` answers 503 when the database doesn't answer, when the last
  maintenance run finished over 5 minutes ago, and, in production, when no run has ever
  finished (the cron is missing or its secret is wrong). Previews and development may have
  no run yet.
- **Retention.** Sent, failed and skipped WhatsApp messages are deleted after 180 days
  ([`src/retention.js`](src/retention.js)), up to 5,000 a run. Once a day, orders delivered,
  cancelled or returned more than `PII_RETENTION_MONTHS` (default 12) months ago lose the
  customer's name, phone, address and gift details, and their delivery attempts lose who took
  the box and the rider's location; amounts, items and tax fields stay for the books. Orders
  with money still owed back wait until it is paid.
- **Erasure and export.** Customers delete their account in the shop (`DELETE /v1/me`) and
  download what we hold about them (`GET /v1/me/export`, JSON). For a deletion request that
  arrives by email or WhatsApp, check it comes from the number's owner, then run
  `node --env-file=.env ops/erase-customer.js --phone <number>` (it shows the account), and
  again with `--yes` to delete it. It refuses while an order is open, like the app. Keep the
  printed id with the request: `ops/reapply-deletions.js --ids <id>` repeats it after a restore.
- **Connections.** `DB_POOL_MAX` sets each instance's pool (default 5 on Vercel, 10
  elsewhere) and `DB_CONNECT_TIMEOUT_MS` how long a request waits for a connection before
  answering 503 BUSY (default 5000). On Vercel, keep instances × `DB_POOL_MAX` under the
  Neon pooler's limit.

### Writing a migration

Migrations run while the previous version is still serving (see
`test/migrations.test.js`), each in one transaction, with `lock_timeout` 5 s
(`MIGRATION_LOCK_TIMEOUT`). A migration that can't get its table lock in that time is
rolled back and tried again twice, 3 s apart; then the build fails and nothing is
half-applied. Look for a long transaction in `pg_stat_activity` and deploy again.
Keep the locks short:

- **Add, then remove a release later.** Drops, renames and narrowing need a
  `-- contract:` line.
- **New CHECK or FOREIGN KEY on an existing table: `NOT VALID`.** A plain
  `ADD CONSTRAINT` reads the whole table while nothing else can touch it. Add it
  `NOT VALID` (new rows are checked from then on) and
  `ALTER TABLE ... VALIDATE CONSTRAINT ...` in the next migration file, which reads the
  table without blocking writes. To change a CHECK (a new notification kind):
  ```sql
  ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
  ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (...)) NOT VALID;
  -- next file: ALTER TABLE notifications VALIDATE CONSTRAINT notifications_kind_check;
  ```
- **Indexes on existing tables block writes while they build.** `CONCURRENTLY` can't run
  inside the migration transaction, so on a big table build it by hand first
  (`CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`) and keep the same `IF NOT EXISTS`
  statement in the migration.
- When a lock is fine (the table is new or small), say why on a `-- locks:` line. The
  migration test fails without one, from file 021 on.
- **After a restore.** A restored database has lost the orders, payments and account
  deletions made since the restore point, while Razorpay still holds the money.
  [`ops/replay-payments.js`](ops/replay-payments.js) `--from <restore point>` applies the
  captured payments as the webhook would and lists payments whose order is gone
  (`--refund-missing` refunds those). [`ops/reapply-deletions.js`](ops/reapply-deletions.js)
  deletes again the accounts deleted since then, from the pre-restore branch (`--old-url`,
  `--since`) or a list of ids (`--ids`). Prefer fixing data forward; restore only when it
  can't be repaired.

## Tests

```bash
npm test   # needs a Postgres database named *_test; default postgres://mango:mango@localhost:5432/mango_test
TEST_DATABASE_URL=postgres://user:pass@host:5432/mango_test npm test
```

The suite drops and recreates the schema of that database, and refuses to run against
one whose name doesn't end in `_test`. It covers the stage engine, staff and customer
auth (refresh rotation and reuse detection, OTP lockout), the full order flow through
claim and replacement, hold expiry and late payments, condemn and rebalance, failed
delivery retries, retirement and the ledger audit, customer cancels and refunds, delivery
slots and WhatsApp updates, preorders, WhatsApp chat ordering, bulk reschedule, the rider
manifest and analytics, double-send and double-refund guards, staff roles and the audit trail, the login code fallback and
the Needs attention view, plus a race of 30 buyers for 10 boxes.

## Not in phase 1

Redis, S3 photo storage and rider
proof of delivery. Dry fruit is out of scope.
