import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { PROFILE_EVENT, SIGNOUT_EVENT, signedInProfile, type Profile, type Stage } from './api'

export interface CartLine {
  sku: string
  stage: Stage
  qty: number
  name: string
  price: number
}

interface Store {
  pincode: string | null
  date: string | null
  setWhere: (pincode: string | null, date: string | null) => void
  cart: CartLine[]
  setQty: (line: Omit<CartLine, 'qty'>, qty: number) => void
  clearCart: () => void
  /** Who is signed in on this device, or null. */
  profile: Profile | null
}

const Ctx = createContext<Store | null>(null)

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked: state lasts as long as the tab.
  }
}

/** Where to deliver and what is in the cart, kept on this device. */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [where, setWhereState] = useState(() => load<{ pincode: string | null; date: string | null }>('mm.where', { pincode: null, date: null }))
  const [cart, setCart] = useState(() => load<CartLine[]>('mm.cart', []))
  const [profile, setProfile] = useState(signedInProfile)

  useEffect(() => save('mm.where', where), [where])
  useEffect(() => save('mm.cart', cart), [cart])
  useEffect(() => {
    const sync = () => setProfile(signedInProfile())
    window.addEventListener(SIGNOUT_EVENT, sync)
    window.addEventListener(PROFILE_EVENT, sync)
    return () => {
      window.removeEventListener(SIGNOUT_EVENT, sync)
      window.removeEventListener(PROFILE_EVENT, sync)
    }
  }, [])

  const setWhere = useCallback((pincode: string | null, date: string | null) => setWhereState({ pincode, date }), [])
  const store: Store = {
    pincode: where.pincode,
    date: where.date,
    setWhere,
    cart,
    setQty: (line, qty) =>
      setCart((c) => {
        const rest = c.filter((l) => !(l.sku === line.sku && l.stage === line.stage))
        return qty > 0 ? [...rest, { ...line, qty }].sort((a, b) => a.name.localeCompare(b.name) || a.stage.localeCompare(b.stage)) : rest
      }),
    clearCart: () => setCart([]),
    profile,
  }
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
