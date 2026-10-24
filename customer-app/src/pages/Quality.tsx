import { Link } from 'react-router-dom'

/** /quality: what we do so the box is at the ripeness the customer chose. Only what the system really does. */
export default function Quality() {
  return (
    <>
      <section className="card" aria-labelledby="quality-title">
        <h1 id="quality-title">How we pick and check every box</h1>
        <p className="lead">Every box is packed for the day you chose, at the ripeness you chose.</p>
      </section>
      <ol className="steps-list">
        <li className="card">
          <h2>We track every batch from the day it is picked</h2>
          <p>Each crate that arrives gets a batch with its picking date. That date tells us how ripe it will be on any day.</p>
        </li>
        <li className="card">
          <h2>Our quality team checks the batches</h2>
          <p>They look at the fruit and adjust a batch's ripeness date when it is ripening faster or slower than usual. Fruit past its best is taken off sale.</p>
        </li>
        <li className="card">
          <h2>We pack from the right batch for your day</h2>
          <p>Raw, semi-ripe or ripe means how the mangoes will be on your delivery day, so we pick the batch that matches, oldest suitable stock first.</p>
        </li>
        <li className="card">
          <h2>It arrives in your time slot</h2>
          <p>You get WhatsApp updates about your order, and the rider confirms the delivery with your code or a photo.</p>
        </li>
        <li className="card">
          <h2>Something wrong? We send a replacement</h2>
          <p>If a box arrives damaged or spoilt, at the wrong ripeness, or doesn't arrive, report it from your order. We look into it and send a free replacement.</p>
        </li>
      </ol>
      <Link to="/" className="btn btn-primary btn-block">
        Shop mangoes
      </Link>
    </>
  )
}
