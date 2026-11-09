# WhatsApp templates

Generated from `mango-api/src/wa/registry.js` by `mango-api/scripts/whatsapp-templates-doc.mjs`. Do not edit by hand.

Each automated message is one Meta template in `WHATSAPP_LANGUAGE` (default `en`), named `WHATSAPP_TEMPLATE_PREFIX` (default `mandi_`) plus the kind, except the managers' summary (`MANAGER_SUMMARY_TEMPLATE`, default `mandimangoes_daily_summary`). The variables are filled in the order listed; a template with a different number of variables is refused before Meta is called (the WhatsApp page shows "Template variables do not match").

The category is what to ask Meta for; Meta decides the final one. A STOP OFFERS also stops every template Meta bills as marketing.

The wording is a suggestion for the submission. Keep the variables, their order and the button; Meta rejects utility templates with promotional text.

| Kind | Template | Category | Variables | Button |
|------|----------|----------|-----------|--------|
| ORDER_CONFIRMED | `mandi_order_confirmed` | UTILITY | 4 | Open order |
| REPLACEMENT_CONFIRMED | `mandi_replacement_confirmed` | UTILITY | 4 | Open order |
| RIPENESS_GUIDE | `mandi_ripeness_guide` | UTILITY | 4 | — |
| DATE_MOVED | `mandi_date_moved` | UTILITY | 4 | Open order |
| OUT_FOR_DELIVERY | `mandi_out_for_delivery` | UTILITY | 4 | Open order |
| GIFT_OUT_FOR_DELIVERY | `mandi_out_for_delivery` | UTILITY | 4 | Open order |
| DELIVERED | `mandi_delivered` | UTILITY | 2 | Open order |
| DELIVERY_FAILED | `mandi_delivery_failed` | UTILITY | 3 | Open order |
| CANCELLED | `mandi_cancelled` | UTILITY | 2 | — |
| REFUNDED | `mandi_refunded` | UTILITY | 3 | — |
| PREORDER_BOOKED | `mandi_preorder_booked` | UTILITY | 4 | — |
| PREORDER_SPOT_OPEN | `mandi_preorder_spot_open` | UTILITY | 4 | — |
| PREORDER_MOVED | `mandi_preorder_moved` | UTILITY | 4 | — |
| BACK_IN_STOCK | `mandi_back_in_stock` | UTILITY | 4 | — |
| REORDER_REMINDER | `mandi_reorder_reminder` | MARKETING | 3 | — |
| REVIEW_REQUEST | `mandi_review_request` | MARKETING | 2 | — |
| CLAIM_RECEIVED | `mandi_claim_received` | UTILITY | 2 | Open order |
| CLAIM_REJECTED | `mandi_claim_rejected` | UTILITY | 3 | Open order |
| REFERRAL_REWARD | `mandi_referral_reward` | MARKETING | 5 | — |
| HELP_REPLY | `mandi_help_reply` | UTILITY | 3 | — |
| SUBSCRIPTION_DUE | `mandi_subscription_due` | UTILITY | 4 | — |
| PARTNER_ENQUIRY_RECEIVED | `mandi_partner_enquiry_received` | UTILITY | 3 | — |
| PARTNER_TEAM_ALERT | `mandi_partner_team_alert` | UTILITY | 4 | — |
| FARM_BOOKING_UPDATE | `mandi_farm_booking_update` | UTILITY | 4 | — |
| FARM_TEAM_ALERT | `mandi_farm_team_alert` | UTILITY | 4 | — |
| MANAGER_DAILY_SUMMARY | `mandimangoes_daily_summary` | UTILITY | 8 | — |
| LOGIN_CODE | `mandi_login_code` | AUTHENTICATION | 1 | Copy code (Meta's one-time password button) |

## ORDER_CONFIRMED

- Template: `mandi_order_confirmed`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A verified payment (Razorpay or Meta payment webhook, or the reconcile) moves the order to CONFIRMED. This is also the payment confirmation.
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)
  3. delivery date (example: Fri, 16 Oct)
  4. slot (example: 7 AM to 11 AM)

Suggested wording: Hi {{1}}, your MandiMangoes order {{2}} is confirmed and paid. It will be delivered on {{3}}, {{4}}.

## REPLACEMENT_CONFIRMED

- Template: `mandi_replacement_confirmed`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: Staff approve a claim and the free replacement order is CONFIRMED.
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1094)
  3. delivery date (example: Sat, 17 Oct)
  4. slot (example: 7 AM to 11 AM)

Suggested wording: Hi {{1}}, your replacement order {{2}} is booked at no cost. It will be delivered on {{3}}, {{4}}.

## RIPENESS_GUIDE

- Template: `mandi_ripeness_guide`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A minute after ORDER_CONFIRMED, only when a box arrives raw or semi-ripe.
- Button: none
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)
  3. when each box is ready (example: Alphonso 3kg Box (raw): ready around Mon, 19 Oct)
  4. storage tip (example: Keep them in a paper bag at room temperature.)

Suggested wording: Hi {{1}}, a guide for order {{2}}: {{3}}. {{4}}

## DATE_MOVED

- Template: `mandi_date_moved`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: Staff move the order (one or a whole day), the customer moves it, or a late payment lands on the next date with stock.
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)
  3. new date (example: Sat, 17 Oct)
  4. slot (example: 7 AM to 11 AM)

Suggested wording: Hi {{1}}, order {{2}} will now arrive on {{3}}, {{4}}. If that date doesn't suit you, cancel it in the app before it is packed for a full refund.

## OUT_FOR_DELIVERY

- Template: `mandi_out_for_delivery`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: Dispatch moves the order to OUT_FOR_DELIVERY.
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the delivery code is also on the order page in the shop.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)
  3. slot (example: 7 AM to 11 AM)
  4. delivery code (example: 4821)

Suggested wording: Hi {{1}}, order {{2}} is on its way and arrives {{3}}. Give the rider code {{4}} when the box reaches you.

## GIFT_OUT_FOR_DELIVERY

- Template: `mandi_out_for_delivery` (shared with OUT_FOR_DELIVERY)
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A gift order goes OUT_FOR_DELIVERY: the recipient gets the code too.
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the buyer has the code on the order page.
- Variables:
  1. recipient name (example: Ravi)
  2. order number (example: ORD-1095)
  3. slot (example: 7 AM to 11 AM)
  4. delivery code (example: 4821)

Suggested wording: (shares mandi_out_for_delivery)

## DELIVERED

- Template: `mandi_delivered`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: The rider marks the order DELIVERED (code, photo or manager override).
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)

Suggested wording: Hi {{1}}, order {{2}} has been delivered. If a box is damaged, report it in the app within a day and we will replace it.

## DELIVERY_FAILED

- Template: `mandi_delivery_failed`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: The rider reports DELIVERY_FAILED; it retries on the next delivery.
- Button: URL button "Open order", `https://<shop>/orders/{{1}}`, sent only with WHATSAPP_ORDER_LINKS=true once Meta approved the button
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)
  3. retry date (example: Sat, 17 Oct)

Suggested wording: Hi {{1}}, we couldn't deliver order {{2}} today. We will bring it on {{3}}.

## CANCELLED

- Template: `mandi_cancelled`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A confirmed order is cancelled (unpaid holds send nothing).
- Button: none
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)

Suggested wording: Hi {{1}}, order {{2}} has been cancelled. If you paid for it, the refund has been started.

## REFUNDED

- Template: `mandi_refunded`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: Razorpay accepts a refund we started (customer cancel before packing, or a manager cancel we cannot deliver). The wording must say the refund has been started.
- Button: none
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order or booking number (example: ORD-1093)
  3. amount (example: Rs 1,899)

Suggested wording: Hi {{1}}, the refund for {{2}} of {{3}} has been started. Your bank usually shows it within 5 to 7 working days.

## PREORDER_BOOKED

- Template: `mandi_preorder_booked`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A booking ahead is paid.
- Button: none
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. booking number (example: PRE-1001)
  3. boxes (example: 2 × Alphonso 3kg Box)
  4. week (example: the week of Mon, 1 Mar)

Suggested wording: Hi {{1}}, booking {{2}} is confirmed: {{3}} for {{4}}. We will confirm the delivery day nearer the time.

## PREORDER_SPOT_OPEN

- Template: `mandi_preorder_spot_open`
- Category: UTILITY
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: A waitlisted booking gets a spot and a payment link.
- Button: none
- If it can't be sent: Not sent: the booking page in the shop shows the payment link.
- Variables:
  1. name (example: Asha)
  2. boxes (example: 2 × Alphonso 3kg Box)
  3. week (example: the week of Mon, 1 Mar)
  4. payment link (example: https://rzp.io/i/abc)

Suggested wording: Hi {{1}}, a spot opened for {{2}} for {{3}}. Pay here to keep it: {{4}}

## PREORDER_MOVED

- Template: `mandi_preorder_moved`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A week passed without stock, so the booking moved a week.
- Button: none
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. booking number (example: PRE-1001)
  3. boxes (example: 2 × Alphonso 3kg Box)
  4. new week (example: the week of Mon, 8 Mar)

Suggested wording: Hi {{1}}, booking {{2}} ({{3}}) moves to {{4}} because the mangoes were not ready. You can cancel it in the app for a full refund.

## BACK_IN_STOCK

- Template: `mandi_back_in_stock`
- Category: UTILITY
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: A box the customer asked about ("Tell me when it is back") is in stock again.
- Button: none
- If it can't be sent: Not sent: the alert is marked done; the shop shows the box.
- Variables:
  1. name (example: Asha)
  2. box (example: Alphonso 3kg Box (ripe))
  3. first day (example: Fri, 16 Oct)
  4. shop link (example: https://mandimangoes.in)

Suggested wording: Hi {{1}}, {{2}} is back. The first delivery day is {{3}}. Order here: {{4}}

## REORDER_REMINDER

- Template: `mandi_reorder_reminder`
- Category: MARKETING
- Who may receive it: Promotional: only with an opt-in (shop setting or START OFFERS), never after STOP or STOP OFFERS
- Sent when: A week after delivery, for customers who turned reminders on, 10 AM to 7 PM, not if they ordered since.
- Button: none
- If it can't be sent: Not sent.
- Variables:
  1. name (example: Asha)
  2. box they had (example: Alphonso 3kg Box)
  3. shop link (example: https://mandimangoes.in)

Suggested wording: Hi {{1}}, enjoyed the {{2}}? Order again here: {{3}}. Reply STOP OFFERS to stop these reminders.

## REVIEW_REQUEST

- Template: `mandi_review_request`
- Category: MARKETING
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: About a day after delivery, once per order, if nothing on it is reviewed yet.
- Only with `WHATSAPP_REVIEW_REQUESTS=true`
- Button: none
- If it can't be sent: Not sent: the order page asks for a review.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)

Suggested wording: Hi {{1}}, how were the mangoes in order {{2}}? Rate them in the app; it helps other customers choose.

## CLAIM_RECEIVED

- Template: `mandi_claim_received`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A customer reports a problem with a delivered order.
- Only with `WHATSAPP_CLAIM_UPDATES=true`
- Button: URL button "Open order", `https://<shop>/orders/{{1}}` (always sent)
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)

Suggested wording: Hi {{1}}, we have your report about order {{2}}. We will look at it and reply here within a day.

## CLAIM_REJECTED

- Template: `mandi_claim_rejected`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: Staff reject a claim (a replacement sends REPLACEMENT_CONFIRMED instead).
- Only with `WHATSAPP_CLAIM_UPDATES=true`
- Button: URL button "Open order", `https://<shop>/orders/{{1}}` (always sent)
- If it can't be sent: Not sent: the order page in the shop shows the same status, and staff see the failure on the WhatsApp page.
- Variables:
  1. name (example: Asha)
  2. order number (example: ORD-1093)
  3. reason (example: The photo shows the box was opened before delivery.)

Suggested wording: Hi {{1}}, we looked into your report about order {{2}} and could not offer a replacement: {{3}}. Reply here if you would like to talk to us about it.

## REFERRAL_REWARD

- Template: `mandi_referral_reward`
- Category: MARKETING
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: A friend's first order is paid; both get the reward code (REFERRALS).
- Button: none
- If it can't be sent: Not sent: the code is on the Account page.
- Variables:
  1. name (example: Asha)
  2. reward (example: 10%)
  3. code (example: THANKS-7K2)
  4. valid until (example: Sun, 30 Nov)
  5. minimum order (example: Rs 999)

Suggested wording: Hi {{1}}, thank you for bringing a friend to MandiMangoes. Here is {{2}} off your next order of {{5}} or more: code {{3}}, valid until {{4}}.

## HELP_REPLY

- Template: `mandi_help_reply`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: Staff reply to a help request (HELP_CENTRE).
- Only with `WHATSAPP_CARE_UPDATES=true`
- Button: none
- If it can't be sent: Not sent: the reply is on the help request page.
- Variables:
  1. name (example: Asha)
  2. request number (example: HLP-12)
  3. link (example: https://mandimangoes.in/help/requests/hlp_1)

Suggested wording: Hi {{1}}, we replied to your help request {{2}}. Read it here: {{3}}

## SUBSCRIPTION_DUE

- Template: `mandi_subscription_due`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A subscription's next box is set up and waits for payment (SUBSCRIPTIONS).
- Only with `WHATSAPP_CARE_UPDATES=true`
- Button: none
- If it can't be sent: Not sent: the subscription page shows the payment.
- Variables:
  1. name (example: Asha)
  2. box (example: 2 × Alphonso 3kg Box)
  3. date (example: Sat, 17 Oct)
  4. link (example: https://mandimangoes.in/account/subscriptions/sub_1)

Suggested wording: Hi {{1}}, your next subscription box, {{2}}, is set for {{3}}. Pay here to confirm it: {{4}}

## PARTNER_ENQUIRY_RECEIVED

- Template: `mandi_partner_enquiry_received`
- Category: UTILITY
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: Someone sends a Partner With Us enquiry and agrees to be contacted (PARTNER_NETWORK, docs/partner-network.md).
- Only with `WHATSAPP_PARTNER_UPDATES=true`
- Button: none
- If it can't be sent: Not sent: the confirmation page shows the reference.
- Variables:
  1. name (example: Asha)
  2. enquiry reference (example: MMP-7K2QXD9T)
  3. partnership type (example: Farmers & Suppliers)

Suggested wording: (write it in WhatsApp Manager)

## PARTNER_TEAM_ALERT

- Template: `mandi_partner_team_alert`
- Category: UTILITY
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: To the numbers in PARTNER_ALERT_PHONES: a new enquiry or product proposal, an enquiry assigned, converted or rejected, and a follow-up due or overdue.
- Only with `WHATSAPP_PARTNER_UPDATES=true`
- Button: none
- If it can't be sent: Not sent: the Partner Network overview shows the same.
- Variables:
  1. what happened (example: New partner enquiry)
  2. enquiry reference (example: MMP-7K2QXD9T)
  3. detail (example: Farmers & Suppliers, Ratnagiri, Maharashtra)
  4. panel link (example: https://ops.mandimangoes.in/partner-network/enquiries/pen_1)

Suggested wording: (write it in WhatsApp Manager)

## FARM_BOOKING_UPDATE

- Template: `mandi_farm_booking_update`
- Category: UTILITY
- Who may receive it: Order and service update: sent unless the number sent STOP
- Sent when: A Farm Experience booking is paid, confirmed, moved, cancelled, refunded, ready for the visit, reminded two days before, or asks the customer to approve extra mangoes (FARM_EXPERIENCE, docs/farm-experience.md).
- Only with `WHATSAPP_FARM_UPDATES=true`
- Button: none
- If it can't be sent: Not sent: the booking page in the shop shows the same status.
- Variables:
  1. name (example: Asha)
  2. booking number (example: MMF-7K2QXD9T)
  3. what happened (example: Your farm visit on Sat, 10 Apr is confirmed. Your itinerary and check-in code are in your booking.)
  4. booking link (example: https://mandimangoes.in/farm-bookings/fbk_1)

Suggested wording: (write it in WhatsApp Manager)

## FARM_TEAM_ALERT

- Template: `mandi_farm_team_alert`
- Category: UTILITY
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: To the numbers in FARM_ALERT_PHONES: a new paid booking, one that needs a manager, a customer request, or a declined stay proposal.
- Only with `WHATSAPP_FARM_UPDATES=true`
- Button: none
- If it can't be sent: Not sent: the Farm Experience Bookings list shows the same.
- Variables:
  1. what happened (example: New paid farm booking)
  2. booking number (example: MMF-7K2QXD9T)
  3. detail (example: 300 kg Alphonso, Sat, 10 Apr, 6 guests)
  4. panel link (example: https://ops.mandimangoes.in/farm/bookings/fbk_1)

Suggested wording: (write it in WhatsApp Manager)

## MANAGER_DAILY_SUMMARY

- Template: `mandimangoes_daily_summary`
- Category: UTILITY
- Who may receive it: Asked for by the person: sent unless the number sent STOP
- Sent when: Each evening, to managers who turned the summary on (MANAGER_DAILY_SUMMARY). Its full template name is MANAGER_SUMMARY_TEMPLATE.
- Button: none
- If it can't be sent: Not sent: the Daily summary page shows the same numbers.
- Variables:
  1. the day (example: Thu, 16 Oct)
  2. orders (example: 42)
  3. revenue (example: Rs 98,430)
  4. boxes delivered (example: 61)
  5. boxes failed (example: 1)
  6. new claims (example: 2)
  7. unhappy ratings (example: 0)
  8. needs attention (example: 3)

Suggested wording: MandiMangoes, {{1}}: {{2}} orders, {{3}} taken. Delivered {{4}} boxes, failed {{5}}. New claims {{6}}, unhappy ratings {{7}}, needs attention {{8}}.

## LOGIN_CODE

- Template: `mandi_login_code`, category AUTHENTICATION, Meta's fixed authentication wording with a copy-code button
- Sent when: A customer asks for a login code and WhatsApp is chosen, or SMS fails.
- Sent directly by `src/sms.js`, not through the order-update outbox; an opt-out does not stop a code the person asked for.
