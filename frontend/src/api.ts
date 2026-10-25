import { useCallback, useEffect, useRef, useState } from 'react'
import { useSync } from './sync'

export type User = { id: string; email: string; name: string; defaultShopId: string | null }
export type Shop = { id: string; name: string; address: string; timezone: string; role: 'owner' | 'member'; isDefault: boolean }
export type Category = { id: string; name: string; isDefault: boolean; active: boolean }
export type Partner = { id: string; name: string; active: boolean; totalHandedOver: string; handoverCount: number }
export type Revenue = { date: string; amount: string }
type TxnBase = { id: string; date: string; amount: string; note: string; createdAt?: string; pending?: boolean; failed?: boolean }
export type Expense = TxnBase & { categoryId: string; categoryName: string }
export type Handover = TxnBase & { partnerId: string; partnerName: string }
export type HistoryDay = { date: string; revenue: string; expenses: string; handovers: string; net: string; balance: string }
export type Totals = { revenue: string; expenses: string; handovers: string; cashInHand: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

/** JSON fetch against /api. status 0 = network failure (offline). */
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'offline', "You're offline. Check your connection.")
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('fs:unauthorized'))
    throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong')
  }
  return data as T
}

/**
 * GET a path and keep it fresh: re-fetches when `path` changes and after every
 * successful sync. `loadedAt` marks when the request started, for the
 * pending-changes overlay. Pass null to skip.
 */
export function useFetch<T>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean; loadedAt: number }>({ loading: true, loadedAt: 0 })
  const seq = useRef(0)
  const { version } = useSync()

  const reload = useCallback(async () => {
    if (!path) return
    const n = ++seq.current
    const startedAt = Date.now()
    setState((s) => ({ ...s, loading: true }))
    try {
      const data = await api<T>(path)
      if (n === seq.current) setState({ data, loading: false, loadedAt: startedAt })
    } catch (e) {
      if (n === seq.current) setState((s) => ({ ...s, error: e as ApiError, loading: false }))
    }
  }, [path])

  useEffect(() => {
    setState({ loading: true, loadedAt: 0 })
    reload()
  }, [reload])

  const seenVersion = useRef(version)
  useEffect(() => {
    if (version === seenVersion.current) return
    seenVersion.current = version
    reload()
  }, [version, reload])

  return { ...state, reload }
}
