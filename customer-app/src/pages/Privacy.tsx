// The privacy notice (India's Digital Personal Data Protection Act, 2023).
// Have it checked by a lawyer before launch.
import { Link } from 'react-router-dom'

export default function Privacy() {
  return (
    <article className="card prose">
      <h1>Privacy notice</h1>
      <p>This explains what MandiMangoes keeps about you, why, and how to have it removed.</p>

      <h2>What we keep</h2>
      <ul>
        <li>Your mobile number, and your name and email if you sign in with Google.</li>
        <li>Delivery addresses and pincodes you give us.</li>
        <li>Your orders, bookings, payments (Razorpay gives us a payment reference, never your card or UPI details) and refunds.</li>
        <li>Problem reports and the photos you add to them, and the rider's photo of a delivery when nobody could give the delivery code.</li>
        <li>WhatsApp messages you send us when you order in the chat.</li>
      </ul>

      <h2>Why</h2>
      <p>
        To take and deliver your orders, send you sign-in codes and order updates by SMS and WhatsApp, refund cancelled orders, replace damaged
        boxes, and keep our accounts as the law requires. We don't sell your details or use them for advertising.
      </p>

      <h2>Who else sees it</h2>
      <ul>
        <li>Razorpay, to take payments and send refunds.</li>
        <li>Meta (WhatsApp) and Jio, to send messages and sign-in codes to your number.</li>
        <li>Google, if you choose to sign in with Google.</li>
        <li>Our riders, who see your name, number and address for the day's deliveries.</li>
      </ul>

      <h2>Where it is stored</h2>
      <p>Our servers and database are in Singapore (Vercel and Neon, on Amazon Web Services).</p>

      <h2>How long</h2>
      <p>
        While you have an account. Sign-in codes are cleared within hours, and photos added to a report that was never sent are cleared after a
        day. Order amounts are kept for our accounts after you delete your account, without your name, number or address.
      </p>

      <h2>Your choices</h2>
      <p>
        You can see your details and delete your account yourself on the <Link to="/account">Account</Link> page. For anything else, such as
        correcting an order's details, message us on WhatsApp.
      </p>
    </article>
  )
}
