# MandiMangoes component inventory

The shop (`customer-app/`) and the staff panel (`src/`) share one token file, [`tokens.css`](tokens.css).
Run `node design/check-contrast.mjs` after changing a colour: every text pair must stay at 4.5:1 or more, light and dark.

## Tokens

| Group | Tokens | Use |
| --- | --- | --- |
| Spacing | `--space-1` … `--space-10` (4px steps: 4, 8, 12, 16, 20, 24, 32, 40) | Margins, gaps, padding |
| Type | `--font-sans`, `--font-mono`; scale `--text-xs` 12.8 · `--text-sm` 14 · `--text-md` 16 · `--text-lg` 18.4 · `--text-xl` 25.6 · `--text-2xl` 36; `--leading` 1.5, `--leading-tight` 1.2 | Two families only; mono is for codes and IDs. No one-off font sizes |
| Surfaces | `--color-bg`, `--color-surface`, `--color-ink`, `--color-muted`, `--color-line` | Page, cards, text, borders |
| Accent | `--color-accent` (fill), `--color-on-accent` (text on it), `--color-accent-strong` (accent text), `--color-accent-soft` (tint) | The one brand colour: primary buttons, active tab, selection |
| Focus | `--color-focus` ring with a `--color-focus-halo` | 3px ring plus a 2px halo, so it shows on any background (3:1 checked) |
| Marks | `--color-star-empty` | Empty stars and other non-text marks (3:1 checked) |
| Disabled | `--color-disabled`, `--color-on-disabled` | Neutral fill for disabled controls. Never fade with opacity; say why in visible text |
| Staff accent | `--color-staff`, `--color-on-staff`, `--color-staff-strong`, `--color-staff-soft` | The panel's green, one token set. Not used in the shop |
| Semantic | `--color-success`, `--color-warning`, `--color-error`, `--color-info`, each with a `-soft` background | Status text and notes. Never colour alone: always with a word |
| Shape | `--radius-sm` 8px (inputs, chips, small cards), `--radius-md` 14px (cards, dialogs), `--radius-pill`, `--tap-min` (44px) | Only these radii. Every control is at least 44px in both apps |
| Motion | `--motion-fast` 150ms, `--motion-base` 200ms, `--motion-slow` 300ms | Become 0ms under `prefers-reduced-motion` |

The shop's older names (`--mango`, `--ink`, `--leaf` …) are aliases of these in `customer-app/src/styles.css`, and the panel's (`--green-*`, `--red-*`, `--text`, `--border` …) are aliases in `src/styles.css`. The only colour literals left are in those alias blocks: shop shadow, `--scrim` and the three stage-dot colours; panel `--surface-2`, `--border-strong`, `--shadow` and `--nav-bg`.

## Rules for both apps

- **Breakpoints:** 640px (chip rows wrap, 3 tiles, panel tables turn into cards below it), 900px (panel menu collapses below it), 1024px (shop top menu, 1120px container, 4 tiles, two-column product and checkout).
- **Accessibility:** axe runs on every page and dialog in both apps (`tests/a11y.spec.ts`, `customer-app/tests/a11y.spec.ts`), at phone and desktop sizes.
- **Badges:** colour only for status (good, warning, error, info). Categories such as slot, gift, issue type and ripeness are neutral chips.
- **Buttons:** primary (filled, one per screen), secondary (outlined), quiet (text, `.link-btn`), danger. Disabled uses the disabled tokens and a visible reason.
- **Role gating (panel):** hide what a role can never do. When a button is shown disabled, say why in text next to it.
- **Spacing:** `--space-*` only; no inline `style` props except values computed at run time.

## Shop components

The names on the left are the spec names. "Today" is where it lives now.

| Spec name | Today | States it handles | Notes |
| --- | --- | --- | --- |
| TopBar | `App.tsx` header + `WhereButton`, `SearchBar` | pincode set / not set, signed in / out | Pincode chip left, profile right, search below. Cart lives in the bottom tabs on phones; from 1024px a top menu (`nav.top-nav`: Home, Book ahead, Orders, Cart with count) replaces the tabs |
| Bottom tabs | `App.tsx` `nav.tabbar` | active tab, cart count | Hidden on checkout, claim and review forms so they never cover the submit button |
| PincodeSheet | `Shop.tsx` `PincodeForm` | empty, checking, not served, no open days | Opens from the chip with `?where=1` |
| ProductCard | `Shop.tsx` `ProductTile` | photo or drawn mango, sold out with next day, in cart count | Two-across tiles; no ripeness on the tile, it is picked on the product page (user's choice, 20 Oct) |
| Product detail / buy box | `Product.tsx` `BuyBox` | no pincode, not on sale here, each ripeness in stock / sold out / low stock, cart already at max | Ripe chosen first when in stock |
| QuantityStepper | `forms.tsx` `Stepper` (Product, Cart, Preorder) | min 1, max from stock (cap 20 until API gap G5) | 40px buttons inside a 44px row |
| Notify me | `Shop.tsx` `NotifyMe` | signed out, waiting, sent | WhatsApp back-in-stock alert |
| SkipLink | `App.tsx` `.skip-link` | hidden until focused | First Tab stop in both apps; focuses `main#main` |
| DocTitle / `pageTitle` | `ui.tsx` | per page | Unique "X · MandiMangoes" titles |
| StarMark | `stars.tsx` | filled, outlined | SVG stars; empty ones outlined in `--color-star-empty` |
| CartSummary | `Checkout.tsx` | desktop only | Sticky order summary on the right from 1024px |
| Sticky buy bar | `Product.tsx` | shown until the buy box scrolls past | "Add to cart · ₹" above the bottom tabs on phones |
| StickyCartBar | `Shop.tsx` `.sticky-cart` | hidden at 0, count + total | Sits above the bottom tabs, safe-area aware |
| Cart | `Cart.tsx` | empty, items, item removed, price changed | Full page, not a sheet |
| Checkout | `Checkout.tsx` | delivery day, slot, address, gift, promo, quote problems | Bill lines come from the server quote |
| AddressForm | `Checkout.tsx`, `Account.tsx` `SavedAddresses` | none saved, saved (max 5), invalid pincode | Autofill attributes set |
| OtpInput | `auth-ui.tsx` `PhoneCodeForm` | sent, wrong, expired, rate-limited, WhatsApp fallback | One field with `one-time-code`; 6-box version is spec work |
| PayButton | `payment.ts` + `Checkout.tsx` | idle, opening, paid, failed, pending confirmation | Razorpay script loads only on Pay |
| Order tracking | `Order.tsx` `OrderView`, `StatusPill` | each status, delivery photo, move day, cancel | |
| ReplacementRequest | `Claim.tsx` | pick items, reason, up to 3 photos, sent, decided | Never says refund |
| Reviews | `Product.tsx`, `Review.tsx`, `stars.tsx` | none, list, filtered, photos, brand reply | |
| Dialog | `ui.tsx` `Dialog` | open / closed | Portal, page made inert, focus trapped, Escape closes, focus returns |
| ConfirmDialog | `ui.tsx` `ConfirmDialog` | idle, busy, error | Built on Dialog; the keep button gets focus first. Order, Preorder, Review, Account |
| PageHeader | `ui.tsx` `PageHeader` | title with an optional status pill | Order, Preorder |
| Field | `forms.tsx` `Field` | hint, error | Visible label, hint, error under the field, `aria-invalid` and `aria-describedby` set. Checkout, Preorder, Claim, Review |
| DayChips | `forms.tsx` `DayChips` | selected day; one Tab stop, arrow keys and Home/End move the choice; wraps from 640px | Checkout, Order (change day), Preorder (weeks) |
| SlotPicker | `forms.tsx` `SlotPicker` | full slots disabled, error | "Delivery time" fieldset; nothing when no slots. Checkout, Order (change day) |
| AddressPicker | `forms.tsx` `AddressPicker` | saved addresses or a new one | Checkout |
| PhotoPicker | `forms.tsx` `PhotoPicker` + `usePhotoUploads` | uploading, error, max reached | Shrinks, uploads and previews photos. Claim, Review |
| Loading / error | `ui.tsx` `Spinner`, `ErrorNote` | loading, error with retry | Skeletons replace spinners in milestone 2 |
| MangoArt / ProductImage | `mango.tsx` | photo set, no photo | Managers add a photo per product on the panel's Products page; without one the drawn mango shows |

## Staff panel

The panel imports the same `tokens.css`. Its colour names are aliases of the shared tokens (above), so a colour changes in one place. Its shared pieces live in `src/ui.tsx`:

| Component | Props | Used on |
| --- | --- | --- |
| `LinkRow` + `RowLink` | `RowLink {to, children, more?}` | Orders, Today, Batches. The first cell holds a real link stretched over the row, so screen readers read the cells (no `tr role=button`) |
| `AuthedPhoto` | `{load, photoKey, alt, what?, className?, openInTab?}` | OrderDetail (delivery proof), Claims, Reviews |
| `ReasonDialog` | `{title, label?, hint?, minLength?, confirmLabel, busy?, error?, tone?, onSubmit, onClose}` | OrderDetail (cancel, override), BatchDetail (write-off), Preorders, Reviews (bulk reject), NeedsAttention. Confirm stays disabled until the reason is long enough, and the hint says so |
| `ConfirmDialog` | `{title, confirmLabel, cancelLabel?, busyLabel?, busy?, error?, tone?, onConfirm, onClose}` | OrderDetail, BatchDetail, Pincodes, Products, Staff, Planning. Cancel gets focus |
| `GatedButton`, `ManagerOnlyNote`, `DisabledReason` | `GatedButton {allowed, onClick, disabled?}`, `ManagerOnlyNote {what}` | OrderDetail, BatchDetail, Pincodes, Preorders, Planning |
| `Badge` (+ `OrderBadge`, `BatchBadge`, `ClaimBadge`) | `{tone?: neutral, good, warn, bad, info}` | Status only; categories use `neutral` |
| Top-bar menus (`src/Layout.tsx`) | grouped nav (Today · Fulfilment · Stock · Customers · Admin) from 900px; a 56px bar with Menu and account below | aria-expanded, focus moves in, Escape returns focus. Roles see only what `canSee` allows |
| `StatusFilter` | `{value, options, labels, onChange}` | Chips from 640px, a select below. Orders, Batches |
| `scrollRegion(label, {cards: true})` | cells marked `card-title`, `card-status`, `card-wide`, `data-label` | Tables become cards below 640px. Orders, Batches |
| `Tabs` + `tabPanelProps` | `{id, value}` | Real tab pattern with arrow keys. BatchDetail |
| `usePageTitle` | `(title)` | Unique "X · Mango Ops" titles on every page |
| `BackLink` | `{to, children}` | "← Orders" above a detail title, 44px tall. OrderDetail (packers get "← Pack list"), BatchDetail |
| `PhoneLink` | `{phone, who?}` | Tap-to-call `tel:` link, 44px tall, "—" when empty. OrderDetail, Claims, Preorders, NeedsAttention |
| `MissedDialog` (`src/MissedDialog.tsx`) | failed-delivery reason from a list, note, photo | OrderDetail, Deliveries |

Labels: the panel never shows enum names or ids. Map them in `src/format.ts` (`STOCK_STATE_LABEL`, `LEDGER_EVENT_LABEL`, `NOTIFICATION_LABEL`, `PAYMENT_METHOD_LABEL`, `ripenessLabel`, `actorLabel`, `telHref`).

## Logo

- Masters: `design/brand/logo-512.png` (full round logo) and `design/brand/mark-512.png` (the M and mango in a badge, for small sizes). Both have a transparent background.
- Served copies sit in `public/brand/` (panel) and `customer-app/public/brand/` (shop): `logo-320.webp` and `logo-640.webp` (2x) for large uses, `mark-96.webp` for headers. Tab icons are `favicon-32.png`, `icon-192.png` and `apple-touch-icon.png`.
- Use the full logo at 96px or larger (welcome, sign-in, panel login). Below that, use the mark: the words can't be read.
- Header marks are decorative (`alt=""`) because the link already says "MandiMangoes, home" or "Mango Ops".
