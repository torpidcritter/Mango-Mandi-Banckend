# Mango Ops — Admin Panel Documentation

Operations tool for MandiMangoes staff: receive stock, run quality control, move
orders through fulfilment, handle claims with replacements, and manage delivery areas.
There are no refunds: a problem with a delivered order is settled by a replacement.

- **App:** React + TypeScript + Vite single-page app (`mango-admin/`)
- **Backend:** talks only to `mango-api` under `/admin/v1`
- **Companion docs:** [README.md](README.md) (dev quick-start), [../vmr_mangoes_admin.md](../vmr_mangoes_admin.md) (full spec/PRD)

---

## 1. What it's for

The panel replaces hand-written API calls (Postman) with buttons that only ever
offer valid actions. Staff can run the shop without a developer, and the UI can't
cause an oversell because **all stock and money rules live in the
API** — the panel only displays what the backend returns.

## 2. Who uses it

One login per staff member, with four roles. Managers add people and set roles on the
**Staff** screen.

| Role | Sees | Can do | Cannot do |
|------|------|--------|-----------|
| **Packer** | Pack list, Deliveries, order pages | Allocate and pack, mark packed, shipped, out for delivery, delivered or missed | Cancel or move orders, anything outside packing and delivery |
| **QC** | Batches | Receive stock, log QC, adjust stock counts, move a batch forward | Condemn a batch, see orders or customers |
| **Operator** | Every screen except Staff | Everything above, plus cancel orders, add/deactivate pincodes, claims | Condemn a batch, delete a pincode, edit rules, move a whole day |
| **Manager** | Everything | Everything, plus Staff and the activity log | — |

Packers and QC staff land on their own screen after signing in, and other screens say
"Not available for your role". Manager-only buttons appear **disabled with "Requires manager role"** for operators.

---

## 3. Getting started

### Run locally
```bash
# 1. Backend (separate terminal)
cd mango-api && npm install && npm run dev        # http://localhost:3000

# 2. Admin panel
cd mango-admin && npm install && npm run dev      # http://localhost:5173
```
The panel reads the API address from `.env` (`VITE_API_URL=http://localhost:3000`).
If it's unset, a red banner warns you.

### Seed logins (change before production)
| Email | Password | Role |
|-------|----------|------|
| `manager@mandimangoes.test` | `manager123` | Manager |
| `ops@mandimangoes.test` | `operator123` | Operator |
| `packer@mandimangoes.test` | `packer123` | Packer |
| `qc@mandimangoes.test` | `qc123` | QC |

### Signing in
Email + password. A wrong login shows a generic "Invalid credentials" (it never
says which field was wrong). Your session is kept via an httpOnly cookie — reload
the page and you stay signed in. If the session expires you're returned to the login
screen with "Your session has ended."

---

## 4. The screens

### Today (dashboard)
Landing page. Tiles count orders by status (Confirmed, Processing, Packed, Shipped,
Out for delivery, Delivery failed) plus Open claims and Payment pending — each tile
links to the matching list. Below: batches 5+ days old still selling (sell or retire
before the 7-day limit) and low-stock SKUs. Auto-refreshes every 60 seconds.

### Batches
**List:** variety, plucked date, age, status, latest QC rating, on-hand / committed /
available. Filter by status (filters live in the URL, so a view is bookmarkable). A
batch with no QC shows **"No QC: not sellable yet"** — the availability engine counts
it as zero until QC is logged.

**Receive batch:** pick variety, plucked date (not in the future), optional farm, and
a quantity per product. Lands you on the new batch's detail with the QC form focused.

**Batch detail:**
- **Stock** per SKU — on-hand, held (reserved by unpaid customers), committed (paid,
  not yet packed), reserve buffer, available. Hover held/committed for a plain-English
  explanation.
- **Status** — moves forward only (`Arriving → In transit → Arrived → Ripening →
  Selling → Exhausted`); the next step is the primary button, skip-ahead is a secondary
  option.
- **Condemn** (manager-only, red) — cancels every open order holding the
  batch; the dialog warns first and lists the cancelled order numbers after.
- **QC** — log ripeness (Raw / Semi-ripe / Ripe) + condition (Good / Minor blemish /
  Reject) + notes. Logging twice in a day warns that the new entry supersedes the old.
- **Adjust stock** — change on-hand or reserve buffer with a required reason. The API
  refuses a value below what's already held or committed.
- **Ledger** — every stock movement (intake, hold, commit, pack, release, adjust) with
  who and when.

### Orders
**List:** order number, customer + phone, item count, total, status, delivery date,
placed time. Filter by status, placed-date range, or search by order number / phone —
all bookmarkable. 50 per page.

**Order detail** shows items, totals, payment, the customer, the status timeline, and
the stock allocation. The **action bar only shows valid actions** for the current
status (see §5). Highlights:
- **Allocate and pack** assigns batch stock, then the pick list appears.
- **Mark packed** is disabled with "Allocate first" until allocation is done.
- **Cancel** needs a 3-character reason; the dialog says whether held stock is released.
- There is no refund action.
- Payment-pending orders show a read-only note — there's no manual confirm, because only
  a verified payment confirms an order.

### Pack list
Printable picking sheet for a delivery date (defaults to tomorrow). Two views:
**By order** (customer + items + which batch to pick from, with an allocate shortcut)
and **By batch** (every batch once, with its picks aggregated across orders — pick a
whole batch at a time). "Print" produces a clean black-on-white sheet with no nav.

### Claims
Queue of post-delivery claims (default: open ones). Each shows the order, customer
phone, issue type, description, affected items, and a photo link if provided.
**Start review** moves a claim to Under review. **Resolve** as Replacement (send the
affected items again) or Reject, behind a confirm dialog. There is no refund option.

### Pincodes
Serviceable delivery areas. Add a pincode (exactly 6 digits + city). **Deactivate**
(behind confirmation — customers there can no longer order) or **Delete** (manager-only,
the dialog suggests deactivating instead).

---

## 5. Business rules the panel enforces

### Order status flow
```
PAYMENT_PENDING ─(payment)─▶ CONFIRMED ─▶ PROCESSING ─▶ PACKED ─▶ SHIPPED ─▶ OUT_FOR_DELIVERY ─▶ DELIVERED
                                                                                     │
                                                      RETURNED(RTO) ◀─ DELIVERY_FAILED ◀┘ (or Retry)
Cancel: allowed from PAYMENT_PENDING through OUT_FOR_DELIVERY (not after).
```
`RTO` is shown as **"Returned."** The panel never offers an invalid transition.

### Batch status
Forward only; `Condemned` can be set from any non-final state and triggers
cancellation of affected orders.

### Destructive actions always confirm
Cancel, condemn, resolve claim, and deactivate/delete pincode each
open a dialog that names the consequence before it runs.

---

## 6. Errors & resilience

- **Session ended** → back to login with a message.
- **Someone else changed the order** (409) → "This order was just updated by someone
  else" and the screen refetches.
- **Offline** → a banner appears until the connection returns.
- **A request failed** → a Retry button, not a dead screen.
- **A screen crashes** → an error card with Reload; the nav survives.
- Unknown URLs show a Not-found page.

## 7. Security

- Access token kept in memory only — never stored, never logged.
- Refresh token in an httpOnly cookie set by the backend.
- No customer data in URLs or logs beyond order numbers.
- All API text is rendered as plain text; the app ships no third-party scripts.
- Use HTTPS in production and set the API's `ADMIN_ORIGIN` to the panel's host.

## 8. Deploying

```bash
cd mango-admin
npm run build          # type-checks, then builds to dist/
```
`dist/` is static files any host serves (Netlify, Vercel, S3, Nginx…). Set
`VITE_API_URL` to the production API and the API's `ADMIN_ORIGIN` to the panel's URL.

## 9. Testing

```bash
npm run typecheck                                  # tsc --noEmit
npx playwright test tests/smoke.spec.ts tests/a11y.spec.ts   # no backend needed
# full flow against a live backend:
E2E_EMAIL=manager@mandimangoes.test E2E_PASSWORD=manager123 \
  npx playwright test tests/day-in-the-life.spec.ts --project=desktop
```
CI (`.github/workflows/ci.yml`) runs typecheck + build + smoke + accessibility on every
push. The accessibility suite runs axe-core (WCAG 2 A/AA) with zero violations.

## 10. Known limitations

- **Needs `mango-api` running.** The panel is a thin client; with no backend it shows
  errors, not data.
- Staff roles and the httpOnly-cookie auth assume the matching backend
  endpoints (all implemented in the current `mango-api`).
- Dry-fruit intake isn't supported yet (needs the backend availability engine to model
  it) — batch intake is mango-only.
- The role split (operator vs manager) is a sensible default; confirm it with the real
  team before launch.

## 11. Reference — screen → endpoint

| Screen | Endpoints (`/admin/v1`) |
|--------|-------------------------|
| Login / session | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` |
| Today | `GET /summary` |
| Batches | `GET /batches`, `GET /batches/:id`, `POST /batches`, `GET /products`, `GET /batches/:id/ledger` |
| Batch actions | `PATCH /batches/:id/status`, `POST /batches/:id/qc`, `PATCH /batches/:id/lines/:lineId` |
| Orders | `GET /orders`, `GET /orders/:id` |
| Order actions | `PATCH /orders/:id/status`, `POST /orders/:id/allocate`, `/cancel` |
| Pack list | `GET /pack-list?date=` |
| Claims | `GET /claims`, `POST /claims/:id/review`, `POST /claims/:id/resolve` |
| Pincodes | `GET/POST /pincodes`, `PATCH/DELETE /pincodes/:pincode` |

All responses use the error shape `{ error: { code, message, requestId } }`.

---

*Admin panel v2 — documented 2026-10-09. Pair with the README for dev setup and the PRD
(`vmr_mangoes_admin.md`) for the full requirement specification.*
