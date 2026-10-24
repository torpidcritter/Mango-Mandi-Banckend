// /terms: the terms of sale: cancellation, refunds and problem reports (UX-3).
//
// NEEDS THE OWNER'S AND A LAWYER'S REVIEW before launch. It states the owner's business rules
// exactly as given (23 Oct 2026): a refund only when the customer cancels before the order is
// packed, or when MandiMangoes cancels an order it cannot deliver; problem reports (claims) are
// put right only with a replacement, never a refund; no cash on delivery. It does not yet name
// the seller's legal entity, address or grievance officer, which India's Consumer Protection
// (E-Commerce) Rules, 2020 ask for; the owner has to supply those. Time limits come from the
// API's live rules (GET /v1/policy).
import { Link } from 'react-router-dom'
import { SupportContact, usePolicy } from './Help'

export default function Terms() {
  const policy = usePolicy().data
  return (
    <article className="card prose">
      <h1>Terms of sale</h1>
      <p className="lead">The rules for buying from MandiMangoes: paying, cancelling, refunds and problems with a box.</p>

      <h2>Prices and payment</h2>
      <ul>
        <li>Prices are per box and include GST. A box costs the same whatever ripeness you choose. Delivery is free.</li>
        <li>You pay online when you order, through Razorpay (UPI, cards or netbanking). There is no cash on delivery.</li>
        <li>
          {policy ? `Your boxes are held for ${policy.holdMinutes} minutes while you pay. ` : 'Your boxes are held for a few minutes while you pay. '}
          If the payment does not reach us in that time, the order is cancelled. If money has already left your account, a
          payment that arrives late is still matched to your order.
        </li>
        <li>The price you pay is the total on the "Review and pay" step. A price change after you pay does not change your order.</li>
      </ul>

      <h2>Cancelling and refunds</h2>
      <p>We refund an order in full only in these two cases:</p>
      <ol>
        <li>You cancel it before it is packed. You can do this from your order page.</li>
        <li>We cancel it because we cannot deliver it.</li>
      </ol>
      <p>There are no other refunds. Once an order is packed it cannot be cancelled or moved to another day.</p>
      <p>Refunds go back to the way you paid. Banks take up to 5 to 7 days to show them. The same rules apply to boxes you book ahead.</p>

      <h2>Problems with a box</h2>
      <ul>
        <li>
          If a box arrives damaged or spoilt, the wrong box arrives, or it does not arrive, report it from your order page
          {policy ? ` within ${policy.claimWindowHours} hours of delivery` : ' within the time shown on your order page'}, with a photo where you can.
        </li>
        <li>We look at every report. We either send a free replacement of the affected boxes, or, if we cannot, tell you why on your order page and on WhatsApp.</li>
        <li>Problems are put right only with a replacement. We do not refund for a problem with a box.</li>
      </ul>

      <h2>Delivery</h2>
      <ul>
        <li>We deliver only to the pincodes we serve, on the day and in the time slot you choose.</li>
        <li>Give the rider the delivery code from your order page once the boxes are in your hands. If nobody can take them, the rider may leave them with someone at your address and take a photo.</li>
        <li>If we miss you, we try again on the next delivery day.</li>
      </ul>

      <h2>Contact</h2>
      <SupportContact />
      <p>
        More on how ordering works is on the <Link to="/help">help page</Link>. How we use your details is in our <Link to="/privacy">privacy notice</Link>.
      </p>
    </article>
  )
}
