import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, type Shop, type User } from './api'
import { clearQueue } from './sync'

type Session = {
  user: User | null
  shops: Shop[]
  shop: Shop | null // the shop currently being viewed
  ready: boolean
  bootError: ApiError | null
  signIn: (u: User) => Promise<void>
  selectShop: (id: string) => void
  reloadShops: () => Promise<Shop[]>
  logout: () => Promise<void>
  retryBoot: () => void
}

const Ctx = createContext<Session>(null!)
export const useSession = () => useContext(Ctx)

const SHOP_KEY = 'fs-shop'

function storedShop(): string | null {
  try {
    return localStorage.getItem(SHOP_KEY)
  } catch {
    return null
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState<string | null>(storedShop)
  const [ready, setReady] = useState(false)
  const [bootError, setBootError] = useState<ApiError | null>(null)
  const [boot, setBoot] = useState(0)

  const reloadShops = useCallback(async () => {
    const { shops } = await api<{ shops: Shop[] }>('/shops')
    setShops(shops)
    return shops
  }, [])

  useEffect(() => {
    setBootError(null)
    api<{ user: User }>('/auth/me')
      .then(async ({ user }) => {
        setUser(user)
        await reloadShops()
      })
      .catch((e: ApiError) => {
        if (e.status !== 401) setBootError(e)
        setUser(null)
      })
      .finally(() => setReady(true))
  }, [boot, reloadShops])

  // Any 401 from the API means the session ended (expired, password reset elsewhere).
  useEffect(() => {
    const onUnauth = () => setUser(null)
    window.addEventListener('fs:unauthorized', onUnauth)
    return () => window.removeEventListener('fs:unauthorized', onUnauth)
  }, [])

  const shop = useMemo(
    () => shops.find((s) => s.id === shopId) ?? shops.find((s) => s.isDefault) ?? shops[0] ?? null,
    [shops, shopId],
  )

  const selectShop = useCallback((id: string) => {
    setShopId(id)
    try {
      localStorage.setItem(SHOP_KEY, id)
    } catch {
      // per-device convenience only
    }
  }, [])

  const logout = useCallback(async () => {
    await api('/auth/logout', 'POST').catch(() => {})
    clearQueue()
    // Cached API responses belong to this user; don't leave them for the next one.
    if ('caches' in window) await caches.delete('fs-api').catch(() => {})
    setUser(null)
    setShops([])
  }, [])

  const signIn = useCallback(async (u: User) => {
    await reloadShops().catch(() => setShops([]))
    setUser(u)
  }, [reloadShops])

  const value = {
    user, shops, shop, ready, bootError, signIn, selectShop, reloadShops, logout,
    retryBoot: () => setBoot((b) => b + 1),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
