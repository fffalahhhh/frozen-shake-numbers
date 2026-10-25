import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { Check, Clock, CloudOff, House, RefreshCw, SlidersHorizontal, TriangleAlert, Users } from 'lucide-react'
import { useSession } from './session'
import { discard, retry, useSync, type Op } from './sync'
import { fmtDate, inr, toPaise } from './lib'
import { Sheet } from './ui'

const NAV = [
  { to: '/', label: 'Today', icon: House },
  { to: '/history', label: 'History', icon: Clock },
  { to: '/partners', label: 'Partners', icon: Users },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
]

function Nav({ className }: { className: string }) {
  return (
    <nav className={className} aria-label="Main">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} end className={({ isActive }) => 'navItem' + (isActive ? ' active' : '')}>
          <Icon size={22} strokeWidth={1.7} />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

function ShopPicker() {
  const { shops, shop, selectShop } = useSession()
  return (
    <label className="shopPick">
      <span className="sr-only">Shop</span>
      <select className="select shopSelect" value={shop?.id ?? ''} onChange={(e) => selectShop(e.target.value)}>
        {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  )
}

function SyncStatus({ onReview }: { onReview: () => void }) {
  const { online, syncing, queue } = useSync()
  const failed = queue.filter((o) => o.error).length
  const pending = queue.length - failed
  if (failed) return <button className="status failed" onClick={onReview}><TriangleAlert size={14} /> {failed} not saved</button>
  if (!online) return <span className="status offline" role="status"><CloudOff size={14} /> Offline{pending ? ` · ${pending} pending` : ''}</span>
  if (syncing || pending) return <span className="status pending" role="status"><RefreshCw size={14} className={syncing ? 'spin' : ''} /> {pending} to sync</span>
  return <span className="status" role="status"><Check size={14} /> Synced</span>
}

function describe(op: Op): string {
  const what = { revenue: 'Revenue', expense: 'Expense', handover: 'Handover' }[op.kind]
  const verb = { put: 'set', create: 'added', update: 'edited', delete: 'deleted' }[op.action]
  const amount = op.body?.amount ? ` ${inr(toPaise(op.body.amount))}` : ''
  const date = op.body?.date ?? (op.kind === 'revenue' ? op.targetId : '')
  return `${what}${amount} ${verb}${date ? ` · ${fmtDate(date)}` : ''}`
}

function FailedSheet({ onClose }: { onClose: () => void }) {
  const { queue } = useSync()
  const failed = queue.filter((o) => o.error)
  return (
    <Sheet open onClose={onClose} title="Changes not saved">
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        The server didn’t accept these changes. They are kept on this device until you retry or discard them.
      </p>
      {failed.length === 0 ? <p>All changes are saved.</p> : (
        <div className="list">
          {failed.map((op) => (
            <div className="row" key={op.opId}>
              <span className="rowCopy"><b>{describe(op)}</b><small style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{op.error}</small></span>
              <span className="rowBtns">
                <button className="pill" onClick={() => retry(op.opId)}>Retry</button>
                <button className="pill danger" onClick={() => discard(op.opId)}>Discard</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}

export default function Layout() {
  const { shop } = useSession()
  const [review, setReview] = useState(false)
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icons/icon-192.png" alt="" />
          <span>Frozen Shake<small>Cash tracker</small></span>
        </div>
        <ShopPicker />
        <Nav className="sideNav" />
        <div className="spacer" />
        <SyncStatus onReview={() => setReview(true)} />
      </aside>
      <main className="main">
        <div className="topbar">
          <ShopPicker />
          <SyncStatus onReview={() => setReview(true)} />
        </div>
        {shop && <Outlet />}
      </main>
      <Nav className="bottomNav" />
      {review && <FailedSheet onClose={() => setReview(false)} />}
    </div>
  )
}
