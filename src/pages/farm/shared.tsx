// Pieces the Farm Experience pages share: status words, badges and the section's links.
import { NavLink } from 'react-router-dom'
import type { Tone } from '../../format'
import { useSession } from '../../session'
import { Badge } from '../../ui'
import type { FarmStatus, HospitalityStatus } from './api'

export const FARM_STATUS_LABEL: Record<FarmStatus, string> = {
  HOSPITALITY_REVIEW: 'Stay to arrange',
  CONFIRMED: 'Confirmed',
  PREPARING: 'Preparing',
  READY_FOR_VISIT: 'Ready for visit',
  CHECKED_IN: 'Checked in',
  HARVESTING: 'Harvesting',
  WEIGHING: 'Weighing',
  PAYMENT_DUE: 'Bill to pay',
  PACKING: 'Paid: packing',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
}
export const FARM_STATUSES = Object.keys(FARM_STATUS_LABEL) as FarmStatus[]

export const HOSPITALITY_LABEL: Record<HospitalityStatus, string> = {
  PENDING: 'Not arranged yet',
  APPROVED: 'Approved',
  ALTERNATIVE_PROPOSED: 'Alternative proposed',
  CUSTOMER_ACCEPTED: 'Customer accepted',
  CUSTOMER_DECLINED: 'Customer declined',
}

export const MOVE_LABEL: Record<string, string> = {
  PREPARING: 'Mark preparing',
  READY_FOR_VISIT: 'Mark ready for visit',
  HARVESTING: 'Start harvesting',
  WEIGHING: 'Start weighing',
  PACKING: 'Start packing',
  COMPLETED: 'Complete',
}

function tone(s: FarmStatus): Tone {
  if (s === 'HOSPITALITY_REVIEW') return 'warn'
  if (s === 'PAYMENT_DUE') return 'info'
  if (s === 'CONFIRMED' || s === 'READY_FOR_VISIT' || s === 'COMPLETED') return 'good'
  if (s === 'NO_SHOW') return 'bad'
  return 'neutral'
}

export function FarmBadge({ status }: { status: FarmStatus }) {
  return <Badge tone={tone(status)}>{FARM_STATUS_LABEL[status] ?? status}</Badge>
}

export const isManager = (role: string | null | undefined) => role === 'MANAGER'
export function useIsManager() {
  return isManager(useSession().me?.role)
}

/** The section's pages, as a row of links under the title. Reports are for managers. */
export function FarmSubnav() {
  const manager = useIsManager()
  const link = ({ isActive }: { isActive: boolean }) => `btn btn-small${isActive ? ' pn-subnav-active' : ''}`
  return (
    <nav className="pn-subnav" aria-label="Farm Experience">
      <NavLink to="/farm/bookings" className={link}>
        Bookings
      </NavLink>
      <NavLink to="/farm/check-in" className={link}>
        Check-in
      </NavLink>
      <NavLink to="/farm/calendar" className={link}>
        Calendar
      </NavLink>
      <NavLink to="/farm/harvest" className={link}>
        Harvest stock
      </NavLink>
      <NavLink to="/farm/rooms" className={link}>
        Rooms
      </NavLink>
      <NavLink to="/farm/settings" className={link}>
        Farm settings
      </NavLink>
      {manager && (
        <NavLink to="/farm/reports" className={link}>
          Reports
        </NavLink>
      )}
    </nav>
  )
}

/** Rupees from paise, for inputs (2 decimals at most). */
export const toRupees = (paise: number) => (paise / 100).toString()
export const toPaise = (rupees: string) => Math.round(Number(rupees) * 100)
