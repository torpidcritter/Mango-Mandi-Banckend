// /admin/v1: the Mango Ops staff panel. Field names follow the panel's
// src/types.ts exactly.
//
// This file only builds the router: sign-in first, then the gate (sign-in,
// two-step setup, role allowlist, rider/packer scope, audit), then each area's
// routes from src/admin/. The areas' paths don't overlap, so the order they are
// mounted in doesn't change which route answers; it follows the old single file.
// Manager-only routes carry requireManager on the route itself.
import express from 'express'
import { auditStaffChanges, limitByRole, riderScope, watchRefusals } from './access.js'
import { requireAdmin } from './auth.js'
import { staffReviews } from './review-routes.js'
import { me, needsSetupFirst, signIn } from './admin/auth.js'
import { router as reports } from './admin/reports.js'
import { router as products } from './admin/products.js'
import { router as batches } from './admin/batches.js'
import { router as orders } from './admin/orders.js'
import { router as deliveries } from './admin/deliveries.js'
import { router as promos } from './admin/promos.js'
import { router as staff } from './admin/staff.js'
import { router as claims } from './admin/claims.js'
import { router as planning } from './admin/planning.js'
import { router as preorders } from './admin/preorders.js'
import { router as recovery } from './admin/recovery.js'
import { router as bulk } from './admin/bulk.js'
import { router as warehouse, warehouseGate } from './admin/warehouse.js'
import { router as customers } from './admin/customers.js'
import { router as exportsRouter } from './admin/exports.js'
import { router as ops } from './admin/ops.js'
import { staffBills } from './bill-routes.js'
import { router as growth } from './admin/growth.js'
import { router as gifts } from './admin/gifts.js'
import { router as care } from './admin/care.js'
import { router as whatsapp } from './admin/whatsapp.js'
import { router as partner } from './admin/partner.js'
import { router as farm } from './admin/farm.js'

export { LIST_LIMIT } from './admin/shared.js'
export { orderDetail } from './admin/orders.js'
export { CLAIM_MANAGER_AFTER } from './admin/claims.js'

export const router = express.Router()

// Sign-in, refresh and logout: before the gate.
router.use(signIn)
// Warehouse paths answer 404 to everyone while WAREHOUSE_V2 is off.
router.use(warehouseGate)

router.use(requireAdmin, needsSetupFirst, watchRefusals, limitByRole, riderScope, auditStaffChanges)
// Review moderation and insights (review-routes.js), behind the same sign-in, roles and audit.
router.use(staffReviews)

router.use(me) // GET /auth/me, /me/two-step/*, /me/password
router.use(reports) // /summary, /analytics, /attention, /notifications/:id/retry, /audit
router.use(products)
router.use(batches)
router.use(orders) // and /pack-list
router.use(gifts) // /gift-orders: gift orders to many recipients with their deliveries (MULTI_GIFT)
router.use(deliveries) // /manifest, dispatch, /riders, delivery photos and reports, /delivery-reviews
router.use(promos)
router.use(staff)
router.use(claims)
router.use(planning) // /pincodes, /config, /calendar, /slots, /coverage
router.use(preorders) // /preorders, /preorder-capacity
router.use(warehouse) // Warehouse and box traceability (WAREHOUSE_V2)
router.use(bulk) // Bulk Deals: listings, tiers, photos, publishing, history (manager only)
router.use(recovery) // manager ways out of Needs attention items (ledger repair, webhooks, refunds, sign out all)
router.use(staffBills) // GET /orders/:id/bill (BILLS_ENABLED)
router.use(customers) // customer profile, phone search and reveal (CUSTOMER_PROFILES_ENABLED)
router.use(exportsRouter) // CSV exports, manager only (STAFF_EXPORTS_ENABLED)
router.use(growth) // /referrals, /analytics/funnel, /me/daily-summary, /daily-summary/preview, manager only (docs/growth.md)
router.use(ops) // stock forecast, farms and purchases, feature switches (docs/ops.md)
router.use(care) // Help desk (HELP_CENTRE) and Subscriptions (SUBSCRIPTIONS): managers and operators
router.use(whatsapp) // WhatsApp inbox (managers and operators), set-up and health (managers), docs/whatsapp/
router.use(partner) // Partner Network: enquiries, follow-ups, product proposals (managers and operators), docs/partner-network.md
router.use(farm) // Farm Experience: bookings, calendar, harvest, rooms, settings, reports (managers and operators), docs/farm-experience.md
