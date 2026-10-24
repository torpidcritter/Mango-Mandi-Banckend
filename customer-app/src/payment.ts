// Razorpay Checkout: the script is loaded on first use. The order is confirmed
// by the API, never by this page: Checkout's success reply is handed to the API
// (verify-payment), which checks its signature and asks Razorpay; the webhook
// and the order page's polling cover a reply that never gets there.
import { api, type CheckoutReply } from './api'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: () => void) => void }
  }
}

try {
  sessionStorage.removeItem('mm.pay') // checkout details were kept here before the order API returned them
} catch {
  // ignore
}

/** Below this many seconds of hold, checkout is not worth opening: the boxes are about to go back on sale. */
export const MIN_PAY_SECONDS = 60

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

/**
 * Opens Razorpay for the order. Resolves when the customer finishes or closes it;
 * after a payment, once the API has checked it (or failed to: the page polls anyway).
 * With `holdExpiresAt` the payment window closes when the boxes stop being held,
 * so nobody pays for stock that has gone back on sale.
 */
export async function openRazorpay(
  p: { orderId: string; key: string; rzp: string; total: number; number: string; holdExpiresAt?: string | null },
  phone: string | null,
) {
  const secondsLeft = p.holdExpiresAt ? Math.floor((new Date(p.holdExpiresAt).getTime() - Date.now()) / 1000) : null
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
      // The window closes with the hold, never later (a payment that still lands late is honoured on the server).
      ...(secondsLeft != null ? { timeout: Math.max(1, secondsLeft) } : {}),
      handler: (reply: CheckoutReply) => {
        api.verifyPayment(p.orderId, reply).then(
          () => resolve(),
          () => resolve(),
        )
      },
      modal: { ondismiss: () => resolve() },
    })
    rz.on('payment.failed', () => resolve())
    rz.open()
  })
}
