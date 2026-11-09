// Which app-feel parts are switched on (docs/app-feel.md). The API decides, in /v1/policy, so
// each part is turned on or rolled back there without a new shop build. Until the answer
// arrives, and with an API too old to say, everything is off.
import { useQuery } from '@tanstack/react-query'
import type { ShopFeatures } from './api'
import { policyQuery } from './queries'

export const FEATURES_OFF: ShopFeatures = { installApp: false, push: false, tracking: false, favourites: false, sortFilter: false, referrals: false, funnel: false, multiGift: false, languages: false, partnerNetwork: false, farmExperience: false }

export function useFeatures(): ShopFeatures {
  const q = useQuery(policyQuery())
  return { ...FEATURES_OFF, ...(q.data?.features ?? {}) }
}

/** Customer care (docs/care.md): the help centre and season subscriptions, as /v1/policy says. Off until it answers. */
export function useCare(): { helpCentre: boolean; subscriptions: boolean; subscriptionsOpen: boolean } {
  const q = useQuery(policyQuery())
  return { helpCentre: false, subscriptions: false, subscriptionsOpen: false, ...(q.data?.care ?? {}) }
}
