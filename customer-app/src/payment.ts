import type { Confirmed } from './api'

// Razorpay Checkout: the script is loaded on first use. Payment is confirmed by
// Razorpay's webhook to the API, never by this page; the order page polls.

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: () => void) => void }
  }
}

const KEY = 'mm.pay'

/** Keeps what's needed to reopen checkout for an unpaid order on this device. */
export function rememberPayment(c: Confirmed) {
  try {
    const all = JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
    all[c.orderId] = { key: c.razorpayKeyId, rzp: c.razorpayOrderId, total: c.total, number: c.number }
    sessionStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // ignore
  }
}
export function rememberedPayment(orderId: string): { key: string | null; rzp: string | null; total: number; number: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}')[orderId] ?? null
  } catch {
    return null
  }
}

let loading: Promise<void> | null = null
function loadScript() {
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve()
    s.onerror = () => {
      loading = null
      reject(new Error('Could not load the payment page. Check your connection and try again.'))
    }
    document.head.appendChild(s)
  })
  return loading
}

/** Opens Razorpay for the order. Resolves when the customer finishes or closes it. */
export async function openRazorpay(p: { key: string; rzp: string; total: number; number: string }, phone: string | null) {
  await loadScript()
  if (!window.Razorpay) throw new Error('Could not load the payment page.')
  await new Promise<void>((resolve) => {
    const rz = new window.Razorpay!({
      key: p.key,
      order_id: p.rzp,
      amount: p.total,
      currency: 'INR',
      name: 'MandiMangoes',
      description: `Order ${p.number}`,
      prefill: phone ? { contact: phone } : undefined,
      theme: { color: '#d97706' },
      handler: () => resolve(),
      modal: { ondismiss: () => resolve() },
    })
    rz.on('payment.failed', () => resolve())
    rz.open()
  })
}
