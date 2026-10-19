// Neighborhood Unlock: how many neighbours have ordered for a delivery day,
// and how many more unlock a reward for the area. Every number comes from the
// server's real count; nothing here is invented, padded or reset. Delivery
// happens whether or not the target is reached, and the card says so.
import { useQuery } from '@tanstack/react-query'
import { api, type UnlockCampaign } from './api'
import { day } from './format'

const closeFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
/** "Fri, 6:00 pm" in India time. */
export const closesText = (iso: string) => closeFmt.format(new Date(iso))

/** "4 of 5", or "6 (target 5)" once past it. */
const tally = (c: UnlockCampaign) => (c.current < c.threshold ? `${c.current} of ${c.threshold}` : `${c.current} (target ${c.threshold})`)

const area = (c: UnlockCampaign) => (c.slotLabel ? `${c.zoneLabel} (${c.slotLabel})` : c.zoneLabel)

/** A link that opens the shop with this pincode and day already chosen. */
export function shareLink(pincode: string, date: string) {
  return `${window.location.origin}/?pin=${encodeURIComponent(pincode)}&date=${encodeURIComponent(date)}`
}

/** A WhatsApp share with the link and the honest numbers. */
export function whatsappShare(c: UnlockCampaign, pincode: string) {
  const text =
    c.remaining > 0
      ? `${c.current} of ${c.threshold} neighbours in ${c.zoneLabel} have ordered MandiMangoes for ${day(c.deliveryDate)}. ${c.remaining} more by ${closesText(c.closesAt)} unlocks a reward for our area: ${shareLink(pincode, c.deliveryDate)}`
      : `Neighbours in ${c.zoneLabel} have reached ${c.threshold} MandiMangoes orders for ${day(c.deliveryDate)}. Order by ${closesText(c.closesAt)}: ${shareLink(pincode, c.deliveryDate)}`
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}

function useProgress(pincode: string | null, date: string | null) {
  return useQuery({
    queryKey: ['unlock', pincode, date],
    queryFn: () => api.unlockProgress(pincode!, date),
    enabled: Boolean(pincode),
    // Always ask again when a page opens, so an order just placed is counted.
    staleTime: 0,
    refetchOnMount: 'always',
    // A card that fails to load just doesn't show: it is a bonus, not part of ordering.
    retry: false,
  })
}

function Bar({ c }: { c: UnlockCampaign }) {
  const pct = Math.min(100, Math.round((c.current / c.threshold) * 100))
  return (
    <div
      className="unlock-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={c.threshold}
      aria-valuenow={Math.min(c.current, c.threshold)}
      aria-label={`${c.current} of ${c.threshold} orders`}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

function message(c: UnlockCampaign) {
  if (c.status === 'UNLOCKED') return `Unlocked: ${c.current} neighbours in ${area(c)} ordered for ${day(c.deliveryDate)}.`
  if (c.status === 'MISSED') return `This one closed at ${c.current} of ${c.threshold}. Every delivery for ${day(c.deliveryDate)} goes ahead as usual.`
  if (c.remaining > 0) return `${c.remaining} more ${c.remaining === 1 ? 'order' : 'orders'} by ${closesText(c.closesAt)} unlocks a reward for ${area(c)}.`
  return `Target reached. It's final when ordering closes at ${closesText(c.closesAt)}, if it stays at ${c.threshold} or more.`
}

/** The full card, for the shop and checkout once a pincode and day are set. */
export function UnlockCard({ pincode, date }: { pincode: string | null; date: string | null }) {
  const q = useProgress(pincode, date)
  const list = q.data?.campaigns ?? []
  if (!pincode || !list.length) return null
  return (
    <>
      {list.map((c) => (
        <section key={`${c.zoneLabel}-${c.slotLabel ?? ''}`} className="card unlock-card" aria-label={`Neighbourhood reward for ${area(c)}`}>
          <p className="unlock-count">
            <strong>{tally(c)}</strong>{' '}
            neighbours in {area(c)} have ordered for {day(c.deliveryDate)}
          </p>
          <Bar c={c} />
          <p className="small">{message(c)}</p>
          {c.status === 'OPEN' && (
            <>
              <p className="muted small">Your delivery comes either way. The count is real and updates as people order or cancel.</p>
              <a className="btn btn-block" href={whatsappShare(c, pincode)} target="_blank" rel="noopener noreferrer">
                Share with neighbours on WhatsApp
              </a>
            </>
          )}
        </section>
      ))}
    </>
  )
}

/** One line, for the order page (confirmation and tracking). */
export function UnlockLine({ pincode, date }: { pincode: string; date: string }) {
  const q = useProgress(pincode, date)
  const c = q.data?.campaigns[0]
  if (!c) return null
  return (
    <p className="note unlock-line" role="status">
      <strong>{tally(c)}</strong>{' '}
      neighbours in {area(c)}. {message(c)}
      {c.status === 'OPEN' && c.remaining > 0 && (
        <>
          {' '}
          <a href={whatsappShare(c, pincode)} target="_blank" rel="noopener noreferrer">
            Share on WhatsApp
          </a>
        </>
      )}
    </p>
  )
}
