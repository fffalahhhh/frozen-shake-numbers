// Offline write queue. Every change (online or not) goes through here:
// it's saved locally first, then replayed against the API in order.
// Replays are safe: expenses/handovers carry a client-generated UUID that the
// server treats as an idempotency key, revenue is an upsert per date, and
// deletes are idempotent. The backend stays the source of truth: after each
// successful sync, screens refetch.
import { useSyncExternalStore } from 'react'
import { api, ApiError } from './api'
import { uuid } from './lib'

export type Kind = 'revenue' | 'expense' | 'handover'
export type Op = {
  opId: string
  shopId: string
  kind: Kind
  action: 'put' | 'create' | 'update' | 'delete'
  targetId: string // expense/handover id, or the date for revenue
  body?: Record<string, any> // includes display fields (e.g. categoryName) the server ignores
  error?: string // set when the server rejected it; kept until retried/discarded
  syncedAt?: number
}

const KEY = 'fs-sync-queue'
const segment = { revenue: 'revenue', expense: 'expenses', handover: 'handovers' }

function load(): Op[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

let queue: Op[] = load()
let recent: Op[] = [] // synced ops, still overlaid until screens have refetched
let inflight: string | null = null
let snapshot = { queue, online: navigator.onLine, syncing: false, version: 0 }
const listeners = new Set<() => void>()

function emit(patch: Partial<typeof snapshot> = {}) {
  snapshot = { ...snapshot, ...patch, queue }
  try {
    localStorage.setItem(KEY, JSON.stringify(queue))
  } catch {
    // storage full / blocked: the queue still lives in memory for this session
  }
  listeners.forEach((l) => l())
}

export function useSync() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  )
}

/** Queue a change and try to send it. Merges with earlier unsent changes to the same record. */
export function enqueue(op: Omit<Op, 'opId'>) {
  const same = (o: Op) => o.shopId === op.shopId && o.kind === op.kind && o.targetId === op.targetId && !o.error && o.opId !== inflight
  if (op.action === 'put') {
    queue = queue.filter((o) => !same(o))
    queue.push({ ...op, opId: uuid() })
  } else if (op.action === 'update' && queue.some(same)) {
    queue = queue.map((o) => (same(o) ? { ...o, body: { ...o.body, ...op.body } } : o))
  } else if (op.action === 'delete') {
    const unsentCreate = queue.some((o) => same(o) && o.action === 'create')
    queue = queue.filter((o) => !same(o))
    if (!unsentCreate) queue.push({ ...op, opId: uuid() })
  } else {
    queue.push({ ...op, opId: uuid() })
  }
  emit()
  void flush()
}

function send(op: Op) {
  const base = `/shops/${op.shopId}/${segment[op.kind]}`
  switch (op.action) {
    case 'put':
      return api(`${base}/${op.targetId}`, 'PUT', op.body)
    case 'create':
      return api(base, 'POST', { ...op.body, id: op.targetId })
    case 'update':
      return api(`${base}/${op.targetId}`, 'PUT', op.body)
    case 'delete':
      return api(`${base}/${op.targetId}`, 'DELETE')
  }
}

export async function flush() {
  if (snapshot.syncing || !queue.some((o) => !o.error)) return
  emit({ syncing: true })
  let synced = 0
  try {
    for (const op of [...queue]) {
      if (op.error || !queue.includes(op)) continue
      inflight = op.opId
      try {
        await send(op)
        queue = queue.filter((o) => o.opId !== op.opId)
        recent.push({ ...op, syncedAt: Date.now() })
        synced++
      } catch (e) {
        const err = e as ApiError
        // Offline, server trouble or signed out: stop and retry later, keeping everything.
        if (err.status === 0 || err.status === 401 || err.status === 429 || err.status >= 500) {
          emit({ online: err.status !== 0 && navigator.onLine })
          break
        }
        // Rejected (validation, conflict...): park it for the user to review.
        queue = queue.map((o) => (o.opId === op.opId ? { ...o, error: err.message } : o))
      } finally {
        inflight = null
      }
    }
  } finally {
    const cutoff = Date.now() - 60_000
    recent = recent.filter((o) => o.syncedAt! > cutoff)
    emit({ syncing: false, version: snapshot.version + (synced ? 1 : 0), ...(synced ? { online: true } : {}) })
  }
}

export function retry(opId: string) {
  queue = queue.map((o) => (o.opId === opId ? { ...o, error: undefined } : o))
  emit()
  void flush()
}

export function discard(opId: string) {
  queue = queue.filter((o) => o.opId !== opId)
  emit()
}

export function clearQueue() {
  queue = []
  recent = []
  emit()
}

/** Ops to overlay on data fetched at `loadedAt`: unsent ones plus ones synced after that fetch began. */
export function overlayOps(shopId: string, kind: Kind, loadedAt: number): Op[] {
  return [...recent.filter((o) => o.syncedAt! > loadedAt), ...queue].filter((o) => o.shopId === shopId && o.kind === kind)
}

/** Apply pending creates/updates/deletes to a fetched list, then keep only rows matching `keep`. */
export function applyOps<T extends { id: string; pending?: boolean; failed?: boolean }>(items: T[], ops: Op[], keep: (item: T) => boolean): T[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  for (const op of ops) {
    const unsent = !op.syncedAt
    if (op.action === 'delete') byId.delete(op.targetId)
    else if (op.action === 'create' || op.action === 'update') {
      const prev = byId.get(op.targetId)
      if (op.action === 'update' && !prev) continue
      byId.set(op.targetId, { ...prev, ...op.body, id: op.targetId, pending: unsent || prev?.pending, failed: !!op.error } as T)
    }
  }
  return [...byId.values()].filter(keep)
}

window.addEventListener('online', () => {
  emit({ online: true })
  void flush()
})
window.addEventListener('offline', () => emit({ online: false }))
// navigator.onLine can be wrong (captive portals, flaky mobile data), so retry periodically too.
setInterval(() => {
  if (queue.some((o) => !o.error)) void flush()
}, 20_000)
void flush()
