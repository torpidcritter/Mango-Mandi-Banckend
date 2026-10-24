import { API_URL, type Stage } from './api'

/** Skin colours by ripeness: green when raw, blushing as it softens, golden when ripe. */
const SKIN: Record<Stage, { base: string; blush: string }> = {
  RAW: { base: '#5f9e3a', blush: '#8fbf4a' },
  SEMI_RIPE: { base: '#b7b83a', blush: '#e8a33a' },
  RIPE: { base: '#f0a020', blush: '#e5672a' },
}

/** A drawn mango in the colour of its ripeness. Decorative: pass a label only when it carries meaning. */
export function MangoArt({ stage, size = 56, label }: { stage: Stage; size?: number; label?: string }) {
  const { base, blush } = SKIN[stage]
  const gid = `mg-${stage}-${size}`
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="mango-art">
      <defs>
        <radialGradient id={gid} cx="38%" cy="70%" r="70%">
          <stop offset="0%" stopColor={blush} />
          <stop offset="100%" stopColor={base} />
        </radialGradient>
      </defs>
      <path d="M34 14c14 2 22 14 20 28-2 12-14 18-26 16S8 46 10 34c2-12 12-21 24-20z" fill={`url(#${gid})`} />
      <path d="M22 26c3-5 8-7 12-7" stroke="#fff" strokeOpacity="0.45" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M33 14c1-5 5-8 10-8-1 5-5 8-10 8z" fill="#2f7d32" />
      <path d="M33 14c0-2 0-4 1-6" stroke="#6b4423" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** How to look after each ripeness once it arrives. */
export const CARE: Record<Stage, { title: string; tips: string[] }> = {
  RAW: {
    title: 'Raw mangoes',
    tips: [
      'Keep them at room temperature, out of the sun. Wrapping them in newspaper or a paper bag speeds things up.',
      "Don't refrigerate them yet: cold stops them ripening.",
      'They are ready in 3 to 4 days, when they smell sweet at the stem and give a little when pressed.',
    ],
  },
  SEMI_RIPE: {
    title: 'Semi-ripe mangoes',
    tips: [
      'Leave them at room temperature for 1 to 2 days.',
      'They are ready when they smell sweet at the stem and give a little when pressed.',
      'Once ripe, eat them or move them to the fridge.',
    ],
  },
  RIPE: {
    title: 'Ripe mangoes',
    tips: [
      'Ready to eat now. Enjoy them within a day or two.',
      'To keep them 2 to 3 more days, put them in the fridge.',
      'Take them out half an hour before eating for the best flavour.',
    ],
  },
}

/** A public photo URL (product or review) resized by the API to `width` px (one of its allowed widths). */
export function photoAt(url: string, width: number) {
  return `${API_URL}${url}${url.includes('?') ? '&' : '?'}w=${width}`
}

/**
 * How a product photo is shown: the widths the browser may pick from, how wide it is on screen,
 * and its intrinsic size (the CSS crops it to that shape, so the space is kept before it loads).
 */
const FIT = {
  tile: { widths: [160, 320, 480, 640], sizes: '(min-width: 1024px) 260px, (min-width: 640px) 31vw, 50vw', width: 480, height: 480 },
  hero: { widths: [480, 640, 960, 1200], sizes: '(min-width: 1024px) 520px, 100vw', width: 1200, height: 900 },
} as const

/**
 * The product's photo when the shop team has added one, else the drawn mango. `priority` is for
 * the photo that is the largest thing on the first screen (the product page's hero): it loads at
 * once and ahead of other images. `eager` is for photos on the first screen (the first home tiles).
 */
export function ProductImage({
  photoUrl,
  name,
  stage = 'RIPE',
  size = 56,
  className,
  fit = 'tile',
  eager = false,
  priority = false,
}: {
  photoUrl?: string | null
  name: string
  stage?: Stage
  size?: number
  className?: string
  fit?: keyof typeof FIT
  eager?: boolean
  priority?: boolean
}) {
  if (!photoUrl) return <MangoArt stage={stage} size={size} />
  const f = FIT[fit]
  return (
    <img
      src={photoAt(photoUrl, f.widths[1])}
      srcSet={f.widths.map((w) => `${photoAt(photoUrl, w)} ${w}w`).join(', ')}
      sizes={f.sizes}
      width={f.width}
      height={f.height}
      alt={`Photo of ${name}`}
      className={className ?? 'product-photo'}
      loading={eager || priority ? 'eager' : 'lazy'}
      decoding={priority ? 'sync' : 'async'}
      // React 18 does not know fetchPriority yet; the lowercase attribute passes straight through.
      {...(priority ? { fetchpriority: 'high' } : {})}
    />
  )
}
