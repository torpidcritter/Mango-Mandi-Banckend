# Mango Ops — Admin Web App

A static single-page admin tool for warehouse and operations staff. It replaces the
Postman-based admin workflow with buttons that only ever offer valid actions, so staff
can run the shop without a developer and without risking an oversell. MandiMangoes settles a problem
with a delivered order by sending a replacement, not a refund.

The backend it talks to, **mango-api**, lives in [`mango-api/`](mango-api/README.md) in
this repo: the `/admin/v1` API this panel uses, the `/v1` storefront API, payments, and
the ripeness and stock engine. The customer shop is in
[`customer-app/`](customer-app/README.md) (`npm run shop:dev`). Going live on Vercel and Neon is in
[`deploy/VERCEL.md`](deploy/VERCEL.md); on a single server, [`deploy/README.md`](deploy/README.md).

## What it does

| Screen | Route | Requirements |
|--------|-------|--------------|
| Login | `/login` | AUTH-1 to AUTH-5 |
| Today | `/today` | DASH-1 to DASH-5 |
| Batches | `/batches` | BAT-1 to BAT-4 |
| Batch detail | `/batches/:id` | BD-1 to BD-8 |
| Orders | `/orders` | ORD-1 to ORD-3 |
| Order detail | `/orders/:id` | OD-1 to OD-9 |
| Pack list | `/pack-list` | PACK-1 to PACK-4 |
| Claims | `/claims` | CLM-1 to CLM-5 |
| Pincodes | `/pincodes` | PIN-1 to PIN-3 |
| Deliveries | `/deliveries` | Rider manifest: each slot's run by pincode, with addresses, phones and boxes; prints |
| Planning | `/planning` | Stock by delivery date and ripeness, delivery calendar, Move a day's orders (managers), slots, selling rules (managers edit) |
| Preorders | `/preorders` | Weekly preorder capacity (managers set) and bookings |
| Analytics | `/analytics` | Season numbers: sales, wastage, at-risk and claims by week and product |
| Staff | `/staff` | Managers add people, set roles and passwords, and read the activity log of every change |

**Thin client.** The UI never computes stock or money. Every total and availability
figure is formatted straight from the API; the backend stays the single authority.

## Stack

- **Vite + React + TypeScript** — static output, typed API responses
- **React Router** — one URL per screen; filters live in the query string so views are bookmarkable
- **TanStack Query** — per-screen caching, refetch after every write, refetch on tab focus
- **Plain CSS** — colour tokens, light/dark themes and print rules in one file (`src/styles.css`)
- **Playwright** — end-to-end tests at phone (390px) and desktop (1280px) widths

## Project layout

```
src/
  api.ts            HTTP client, silent token refresh, every admin call
  types.ts          DTO shapes and status enums mirroring the API
  format.ts         rupee + IST date formatting, status display labels
  permissions.ts    operator vs manager split
  session.tsx       signed-in user context
  ui.tsx            Badge, Dialog, Toast, Spinner, EmptyState, QueryError, ErrorBoundary
  styles.css        tokens, components, dark mode, print
  App.tsx           router, auth guard, session restore, sign-out listener
  Layout.tsx        nav + per-screen error boundary
  main.tsx          React + Query + Toast providers
  pages/            one file per screen
tests/
  fixtures.ts       console-error-failing fixture
  mock-api.ts       in-memory /admin/v1 stand-in for backend-free specs
  smoke.spec.ts     backend-free: auth guard, login, session restore, banners
  screens.spec.ts   backend-free: every screen and its actions, no horizontal scroll
  a11y.spec.ts      backend-free: axe WCAG 2 A/AA on login and every screen
  day-in-the-life.spec.ts   §10 acceptance script (needs backend)
```

## Running it

```bash
cp .env.example .env          # set VITE_API_URL to the API address
npm install
npm run dev                   # http://localhost:5173
```

The API must allow this origin via its `ADMIN_ORIGIN` setting (default
`http://localhost:5173`).

### Build for production

```bash
npm run build                 # tsc --noEmit, then vite build → dist/
npm run preview               # serve the built dist/ locally
```

`dist/` is static files any host can serve. Set the API's `ADMIN_ORIGIN` to the host
you deploy to.

## Tests

```bash
npm run typecheck             # tsc --noEmit
npx playwright install chromium   # once, if not already present
npm run test:e2e              # all specs at both viewports

# Just the backend-free gate (smoke + screens + accessibility):
npx playwright test tests/smoke.spec.ts tests/screens.spec.ts tests/a11y.spec.ts

# Using an already-installed Chromium instead of Playwright's download:
PW_CHROMIUM_PATH=/path/to/chrome npm run test:e2e

# Full day-in-the-life script against a local mango-api with demo data
# (start it first: cd mango-api && COOKIE_SECURE=false npm start):
E2E_EMAIL=manager@mandimangoes.test E2E_PASSWORD=manager123 VITE_API_URL=http://localhost:3000 \
  npx playwright test tests/day-in-the-life.spec.ts
```

- **Smoke** (`tests/smoke.spec.ts`) — auth guard, session-ended banner, offline
  banner, config banner. Runs without a backend.
- **Screens** (`tests/screens.spec.ts`) — every screen and its main actions against
  the mocked API in `tests/mock-api.ts`, including the exact request bodies, that no
  refund action appears anywhere, and the manager-only gates. Runs without a backend.
- **Accessibility** (`tests/a11y.spec.ts`) — axe-core WCAG 2 A/AA scan of the login
  screens and every signed-in screen, plus keyboard-operability checks. Runs without a backend.
- **Day-in-the-life** (`tests/day-in-the-life.spec.ts`) — the full §10 acceptance
  flow against the real mango-api: receive and QC a batch, a customer checks out and
  pays, ops pack, ship and deliver, the customer claims, ops approve a replacement.
  Skips unless `E2E_EMAIL`/`E2E_PASSWORD` are set.

Both viewports (390px phone, 1280px desktop) run on every spec, and a shared fixture
fails any test that logs a console error.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every PR: `npm ci`,
typecheck (panel, tests and customer app), production builds of both apps, then the
smoke, screens and accessibility specs on Chromium. A second job runs the mango-api tests
against Postgres 16, and a third starts mango-api with demo data and runs the
day-in-the-life spec and the customer app's journey against it. A fourth builds the
production Docker images and validates the server config in `deploy/`.
The Playwright report is uploaded as an artifact on failure.

## Resilience

- An **offline banner** appears while the browser is offline and clears when the
  connection returns, so staff know why actions are failing.
- A **config banner** warns when `VITE_API_URL` is unset.
- Every failed query shows a **Retry** button; a render error is caught by an
  **error boundary** that keeps the nav and offers a reload.

## Session and security notes

- The **access token** lives in memory only — never in storage, never logged.
- The **refresh token** is an **httpOnly cookie** set by the backend (v2 / Q4). JS
  cannot read it, so on every page load the app attempts one silent refresh
  (`api.bootstrap`) to restore the session; a returning user is logged straight in,
  and a failed refresh lands them on `/login?reason=expired` with a "session has
  ended" banner. All requests send credentials, so the API must allow them
  (`Access-Control-Allow-Credentials: true` + exact `ADMIN_ORIGIN`).
- On any 401 the client refreshes once and retries once; concurrent 401s share a
  single refresh call. A failed refresh signs the user out.

## Roles

`GET /admin/v1/auth/me` returns `{ email, role }` with role `MANAGER`, `OPERATOR`,
`PACKER` or `QC`. The signed-in identity shows in the nav.

- **Packer**: Pack list, Deliveries and order pages; allocate, pack and move orders
  through delivery. No cancelling or moving dates.
- **QC**: Batches only; receive, log QC, adjust counts, move a batch forward.
- **Operator**: every screen except Staff. Irreversible actions are **manager-only** and
  appear disabled with "Requires manager role": condemning a batch, deleting a pincode,
  editing the selling rules and moving a whole day's orders.
- **Manager**: everything, plus the Staff screen and its activity log.

Packers and QC land on their own screen; other screens show "Not available for your
role" and are hidden from the nav. The API enforces the same split on its own
(`mango-api/src/access.js`); the panel's copy is `src/permissions.ts`.

## Replacements, not refunds

The business replaces products instead of refunding. The panel has no refund button
on orders, and a claim can only be resolved as **Replacement** or **Reject**. The one
refund is automatic: a customer who cancels a paid order before it is packed gets the
full amount back, and the order page shows the refund. Condemning a batch moves its
orders to other stock or flags them **at risk** (listed on Today and on the order);
it never cancels them.

## Known gaps

- `RTO` order status is shown as **"Returned"** in the UI.

See §12 of the admin PRD for the open questions (Q1–Q7) and risks.
