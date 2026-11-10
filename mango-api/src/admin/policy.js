// Who must confirm what, and which reads are recorded: plain data, read by the routes
// (admin/step-up.js, access.js), test/step-up-routes.test.js and the generated
// docs/authorization-matrix.md (scripts/auth-matrix-doc.js). Who may call each route
// at all is access.js, snapshotted in test/fixtures/role-policy.json.

/**
 * Every route that asks the manager to confirm it is them. `always`: asks even with
 * STAFF_STEP_UP off; otherwise only with it on (the default in production). `when`:
 * the requests that ask, in plain words (the rest of that route's requests do not).
 */
export const STEP_UP_ROUTES = [
  { route: 'POST /orders/:id/cancel', always: true, when: 'Cancelling a paid order, which refunds it in full' },
  { route: 'POST /preorders/:id/cancel', always: true, when: 'Cancelling a paid booking, which refunds it in full' },
  { route: 'POST /webhook-failures/:id/refund', always: true, when: 'Refunding a payment that matches no order' },
  { route: 'POST /refunds/:id/paid-another-way', always: true, when: 'Recording a refund paid outside Razorpay' },
  { route: 'POST /staff/sign-out-all', always: true, when: 'Signing every staff member out' },
  { route: 'POST /products', always: true, when: 'Adding a product (it goes on sale with its price)' },
  { route: 'PATCH /products/:sku', always: true, when: 'Changing a price, GST rate or HSN code' },
  { route: 'DELETE /products/:sku', always: true, when: 'Removing a product' },
  { route: 'POST /promos', always: true, when: 'Adding a promo code' },
  { route: 'PATCH /promos/:code', always: true, when: 'Changing a promo code (on or off, end date, limit, note)' },
  { route: 'POST /bulk-listings', always: true, when: 'Adding a bulk deal with its price tiers' },
  { route: 'PATCH /bulk-listings/:id', always: true, when: 'Changing a bulk deal\'s tiers or quantities' },
  { route: 'PUT /config', always: true, when: 'Changing the shop rules (fees, windows, limits)' },
  { route: 'POST /batches/:id/purchases', always: true, when: 'Recording what a batch cost' },
  { route: 'PATCH /batches/:id/purchases/:purchaseId', always: true, when: 'Changing what a batch cost' },
  { route: 'PUT /settings/switches/:key', always: true, when: 'Turning a feature on or off' },
  { route: 'POST /farm/bookings/:id/record-payment', always: true, when: 'Recording a farm bill paid at the farm (UPI, card, cash, bank)' },
  { route: 'POST /farm/refunds/:id/settle', always: true, when: 'Recording a farm refund paid outside Razorpay' },
  { route: 'POST /farm/varieties', always: true, when: 'Adding a farm variety with its price per kg' },
  { route: 'PATCH /farm/varieties/:id', always: true, when: 'Changing a farm variety\'s price or tiers' },
  { route: 'PUT /farm/settings', always: true, when: 'Changing Farm Experience settings, policies or opening bookings' },
  { route: 'PUT /whatsapp/automations/:kind', always: false, when: 'Turning an automated WhatsApp message on or off' },
  { route: 'POST /staff', always: false, when: 'Adding staff' },
  { route: 'PATCH /staff/:id', always: false, when: 'Changing a role or password' },
  { route: 'POST /staff/:id/two-step/reset', always: false, when: 'Resetting someone\'s two-step sign-in' },
  { route: 'POST /staff/:id/two-step/setup-code', always: false, when: 'Giving out a two-step setup code' },
  { route: 'DELETE /staff/:id', always: false, when: 'Removing someone' },
  { route: 'POST /me/two-step/setup', always: false, when: 'Turning your own two-step on from a signed-in session' },
]

/**
 * Staff GETs that show customers' personal details: each view leaves a compact row in
 * staff_audit (STAFF_AUDIT_TRAIL; access.js auditRead). GET /orders is recorded only for a
 * search. Customer profiles, reveals, bills and exports record every look on their own
 * (staff-audit.js auditNow, docs/trust.md).
 */
export const READ_AUDITED_ROUTES = [
  'GET /orders/:id', 'GET /manifest', 'GET /claims', 'GET /orders/:id/delivery-photos/:photoId', 'GET /claims/:id/photos/:photoId',
  'GET /whatsapp/conversations/:id', 'GET /whatsapp/media/:id',
  'GET /partner-network/enquiries/:id', 'GET /partner-network/enquiries/:id/documents/:documentId', 'GET /partner-network/product-proposals/:id',
  'GET /farm/bookings/:id', 'GET /farm/check-in/:code',
]
export const ALWAYS_AUDITED_READS = ['GET /customers/:id', 'GET /orders/:id/bill', 'GET /exports/:kind']
