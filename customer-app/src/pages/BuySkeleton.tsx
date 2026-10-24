/**
 * The product page's buy box while it loads: the photo's space, the name, rating and price lines
 * and the ripeness choices, about as tall as the real box, so what is under it does not jump.
 * In the main bundle: it is also what shows while the product page's code loads.
 */
export function BuySkeleton() {
  return (
    <section className="card buy buy-skeleton" aria-busy="true">
      <span className="sr-only" role="status">
        Loading this box…
      </span>
      <div className="buy-media" aria-hidden="true">
        <div className="product-hero" />
      </div>
      <div className="buy-body" aria-hidden="true">
        <span className="sk sk-line sk-short" />
        <span className="product-rating" />
        <span className="sk sk-line sk-shorter" />
        <span className="sk sk-line" />
        <span className="sk sk-block" />
        <span className="sk sk-block" />
        <span className="sk sk-block" />
      </div>
    </section>
  )
}
