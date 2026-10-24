// /help: how ordering, delivery days, ripeness, cancelling and problem reports work, and how to
// reach a person (UX-1, UX-3).
//
// NEEDS THE OWNER'S REVIEW before launch: the wording, the help hours and the grievance contact.
// India's Consumer Protection (E-Commerce) Rules, 2020 ask for a grievance officer's name and
// contact details on the site; the owner has not given them, so none are made up here.
// The rules quoted (hold, cutoff, days ahead, report window) come from the API's live rules.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { STAGE_HINT, STAGE_LABEL, helpLink, helpNumber } from '../format'
import type { Stage } from '../api'

const STAGES: Stage[] = ['RAW', 'SEMI_RIPE', 'RIPE']

/** The shop's live rules, for help and terms text. */
export const usePolicy = () => useQuery({ queryKey: ['policy'], queryFn: api.policy, staleTime: 10 * 60_000 })

/** How to reach a person: WhatsApp (link and number). Production builds always have the number. */
export function SupportContact() {
  const link = helpLink('Hello MandiMangoes, I need help')
  const number = helpNumber()
  if (!link) {
    // Only a dev or test build gets here (support.ts stops a production build without the number).
    return <p>Message us on WhatsApp at the shop's number. (This test build has no help number set.)</p>
  }
  return (
    <p>
      Message us on WhatsApp at{' '}
      <a href={link} target="_blank" rel="noopener noreferrer">
        {number}
        <span className="sr-only"> (opens WhatsApp)</span>
      </a>
      . Tell us your order number if you have one, and add a photo if something is wrong with a box.
    </p>
  )
}

export default function Help() {
  const policy = usePolicy().data
  const hours = policy?.claimWindowHours
  return (
    <article className="card prose">
      <h1>Help</h1>
      <p className="lead">How ordering from MandiMangoes works, and how to reach us.</p>

      <h2>Talk to us</h2>
      <SupportContact />

      <h2>How ordering works</h2>
      <ol>
        <li>Enter your pincode to see what we have for your area and day. Prices are the same for every ripeness.</li>
        <li>Open a box, choose the ripeness and how many boxes, and add them to your cart.</li>
        <li>Sign in with your mobile number, then choose the delivery day, the time slot and the address.</li>
        <li>
          Pay online with Razorpay: UPI, cards or netbanking. There is no cash on delivery.
          {policy ? ` Your boxes are held for ${policy.holdMinutes} minutes while you pay.` : ' Your boxes are held for a few minutes while you pay.'}
        </li>
        <li>We send updates about your order on WhatsApp, and you can follow it on your order page.</li>
      </ol>

      <h2>Delivery days</h2>
      <ul>
        <li>Delivery is free, in the time slot you choose.</li>
        <li>
          {policy
            ? `Orders for the next day close at ${policy.cutoffTime.replace(' IST', '')} (India time). You can choose a day up to ${policy.maxDaysAhead} days ahead.`
            : 'Orders for the next day close in the evening (India time). You can choose a day a few days ahead.'}
        </li>
        <li>
          Want a box in a later week? <Link to="/preorder">Book ahead</Link>.
        </li>
        <li>If we miss you, we try again on the next delivery day and tell you on WhatsApp.</li>
        <li>When the rider arrives, give them the 4-digit code from your order page or WhatsApp, once the boxes are in your hands.</li>
      </ul>

      <h2>Ripeness</h2>
      <p>You choose how ripe the mangoes are on the day they arrive. We pack from the batch that will be right on that day.</p>
      <ul>
        {STAGES.map((s) => (
          <li key={s}>
            <strong>{STAGE_LABEL[s]}:</strong> {STAGE_HINT[s]}
          </li>
        ))}
      </ul>
      <p>
        Each box shows an "eat by" day. More on how we check every batch: <Link to="/quality">How we pick and check</Link>.
      </p>

      <h2>Changing or cancelling an order</h2>
      <ul>
        <li>Until your order is packed you can move it to another day, or cancel it for a full refund, from your order page.</li>
        <li>Once it is packed it can no longer be moved or cancelled.</li>
        <li>Refunds go back to the way you paid. Banks take up to 5 to 7 days to show them.</li>
      </ul>

      <h2>Something wrong with your box?</h2>
      <ul>
        <li>
          If a box arrives damaged or spoilt, the wrong box arrives, or it doesn't arrive, report it from your order page
          {hours ? ` within ${hours} hours of delivery` : ' soon after delivery'}, with a photo.
        </li>
        <li>We look at every report and reply on your order page and on WhatsApp. If we can, we send a free replacement. If we can't, we tell you why.</li>
        <li>Problems are put right with a replacement, not a refund.</li>
      </ul>

      <p>
        The full rules are in our <Link to="/terms">terms of sale</Link>. How we use your details is in our <Link to="/privacy">privacy notice</Link>.
      </p>
    </article>
  )
}
