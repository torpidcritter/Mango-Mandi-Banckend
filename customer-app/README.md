# MandiMangoes customer app

The shop customers use on their phones: pick a delivery day and the ripeness they
want, sign in with a code sent to their phone, choose a delivery time, pay with
Razorpay, follow the order, cancel it for a full refund before it is packed, and
report a problem after delivery. It talks to mango-api's `/v1` routes.

It is a Vite + React + TypeScript app that shares the repo root's `node_modules`,
so there is nothing extra to install.

```bash
npm install                       # at the repo root, once
npm run shop:dev                  # http://localhost:5174, API at VITE_API_URL (default http://localhost:3000)
npm run shop:build                # production build in customer-app/dist
```

Allow the app's address in the API with `CUSTOMER_ORIGIN` (default
`http://localhost:5174`; comma-separate several).

## Screens

| Path | What it does |
|------|--------------|
| `/` | Pincode check, delivery-day chips, each box in raw, semi-ripe and ripe with its eat-by date and stock left |
| `/cart` | Boxes kept on this device until checkout |
| `/sign-in` | Phone number, then the 6-digit code; resend by SMS or WhatsApp |
| `/checkout` | Delivery time, name and address, a priced review, then Razorpay |
| `/orders`, `/orders/:id` | Order list; progress, delivery details, live payment status, cancel |
| `/orders/:id/claim` | Report damaged, wrong or missing boxes within the claim window |

## Payments

Checkout creates the order, then opens Razorpay Checkout with the key the API
returns. The page never decides an order is paid: Razorpay's webhook tells the
API, and the order page polls until the status changes. Closing the Razorpay
window leaves the order waiting for payment with a Pay button while the boxes are
held. In development, with no Razorpay key set, the order page shows **Payment
succeeds** and **Payment fails** buttons that use the API's test payment route.

## Test

```bash
cd customer-app && npx playwright test   # needs mango-api running in development mode
```

One journey runs on phone and desktop widths: an unserved pincode, picking boxes,
the cart, signing in with the test code, checkout, a test payment, cancelling with
a refund, and signing out, with an accessibility check on each main screen.
