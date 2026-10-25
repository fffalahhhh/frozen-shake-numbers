import { useEffect, useState, type FormEvent } from 'react'
import { Check, Download, LogOut, Plus, Smartphone, Store, User } from 'lucide-react'
import { api, ApiError, useFetch, type Category, type Partner, type Shop } from '../api'
import { useSession } from '../session'
import { useSync } from '../sync'
import { isIOS, isStandalone, useInstallPrompt } from '../pwa'
import { PageHead, Skeleton, useConfirm } from '../ui'

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong')

export default function Settings() {
  const shop = useSession().shop as Shop
  const base = `/shops/${shop.id}`
  const cats = useFetch<{ categories: Category[] }>(`${base}/categories`)
  const parts = useFetch<{ partners: Partner[] }>(`${base}/partners`)
  return (
    <>
      <PageHead eyebrow="Make it yours" title="Settings" sub="Shop details, expense categories and partners." />
      <div className="settingsGrid">
        <div>
          <NamedList
            title="Categories" addLabel="Add a category" placeholder="For example, packaging"
            items={cats.data?.categories} path={`${base}/categories`} reload={cats.reload}
            sub={(c) => (c as Category).isDefault ? 'Default category' : 'Custom category'}
            hideLabel="Hide" showLabel="Show" hiddenTitle="Hidden categories"
            hideNote="Hidden categories stay on past expenses but can’t be picked for new ones."
          />
          <NamedList
            title="Partners" addLabel="Add a partner" placeholder="Partner name"
            items={parts.data?.partners} path={`${base}/partners`} reload={parts.reload}
            sub={() => 'Cash recipient'}
            hideLabel="Deactivate" showLabel="Reactivate" hiddenTitle="Inactive partners"
            hideNote="Past handovers keep the partner’s name even after renaming or deactivating."
          />
        </div>
        <div>
          <ShopDetails key={shop.id} shop={shop} />
          <Shops />
          <AppSection />
        </div>
      </div>
    </>
  )
}

type Named = { id: string; name: string; active: boolean }

function NamedList(props: {
  title: string; addLabel: string; placeholder: string; items?: Named[]; path: string; reload: () => void
  sub: (i: Named) => string; hideLabel: string; showLabel: string; hiddenTitle: string; hideNote: string
}) {
  const { items, path, reload } = props
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      reload()
      return true
    } catch (e) {
      setError(errMsg(e))
      return false
    }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() && (await run(() => api(path, 'POST', { name: name.trim() })))) setName('')
  }
  const rename = async (e: FormEvent) => {
    e.preventDefault()
    if (editing && (await run(() => api(`${path}/${editing.id}`, 'PUT', { name: editing.name })))) setEditing(null)
  }
  const active = items?.filter((i) => i.active) ?? []
  const hidden = items?.filter((i) => !i.active) ?? []
  const row = (i: Named) => (
    <div className="row" key={i.id} style={{ minHeight: 56 }}>
      {editing?.id === i.id ? (
        <form className="inlineEdit" onSubmit={rename}>
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus maxLength={60} aria-label="New name" />
          <button className="pill">Save</button>
          <button type="button" className="pill" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : (
        <>
          <span className="rowCopy"><b>{i.name}</b><small>{i.active ? props.sub(i) : 'Not shown when adding'}</small></span>
          <span className="rowBtns">
            <button className="pill" onClick={() => setEditing({ id: i.id, name: i.name })}>Rename</button>
            <button className="pill" onClick={() => run(() => api(`${path}/${i.id}`, 'PUT', { active: !i.active }))}>
              {i.active ? props.hideLabel : props.showLabel}
            </button>
          </span>
        </>
      )}
    </div>
  )
  return (
    <section>
      <div className="sectionHead"><h2>{props.addLabel}</h2></div>
      <form className="addRow" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={props.placeholder} maxLength={60} aria-label={props.addLabel} />
        <button className="plus" aria-label={props.addLabel}><Plus size={20} /></button>
      </form>
      {error && <p className="formError" style={{ marginTop: 8 }}>{error}</p>}
      <div className="sectionHead"><h2>{props.title}</h2><span className="count">{active.length}</span></div>
      {!items ? <Skeleton rows={2} /> : <div className="list">{active.map(row)}</div>}
      {hidden.length > 0 && (
        <>
          <div className="sectionHead"><h2>{props.hiddenTitle}</h2><span className="count">{hidden.length}</span></div>
          <div className="list">{hidden.map(row)}</div>
        </>
      )}
      <p className="hint">{props.hideNote}</p>
    </section>
  )
}

function ShopDetails({ shop }: { shop: Shop }) {
  const { reloadShops, selectShop } = useSession()
  const confirm = useConfirm()
  const [form, setForm] = useState({ name: shop.name, address: shop.address, timezone: shop.timezone })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const owner = shop.role === 'owner'
  const zones = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined

  const save = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api(`/shops/${shop.id}`, 'PUT', form)
      await reloadShops()
      setMsg({ ok: true, text: 'Saved' })
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) })
    }
  }
  const setDefault = async (isDefault: boolean) => {
    try {
      await api(`/shops/${shop.id}`, 'PUT', { isDefault })
      await reloadShops()
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) })
    }
  }
  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${shop.name}?`,
      message: 'This permanently deletes the shop and all of its revenue, expenses, handovers, categories and partners. This can’t be undone.',
      confirm: 'Delete shop',
    })
    if (!ok) return
    try {
      await api(`/shops/${shop.id}`, 'DELETE')
      const rest = await reloadShops()
      const next = rest.find((s) => s.isDefault) ?? rest[0]
      if (next) selectShop(next.id)
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) })
    }
  }

  return (
    <section>
      <div className="sectionHead"><h2>Shop details</h2></div>
      <form className="card" style={{ padding: 16 }} onSubmit={save}>
        <label className="field"><span>Shop name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!owner} required maxLength={60} /></label>
        <label className="field"><span>Address <small style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</small></span><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} disabled={!owner} maxLength={300} /></label>
        <label className="field">
          <span>Timezone</span>
          <select className="select" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} disabled={!owner}>
            {(zones?.includes(form.timezone) ? zones : [form.timezone, ...(zones ?? [])]).map((z) => <option key={z}>{z}</option>)}
          </select>
          <p className="hint">“Today” and new records use this timezone’s date.</p>
        </label>
        <label className="row" style={{ minHeight: 48, padding: 0, borderBottom: 0, gap: 10 }}>
          <input type="checkbox" checked={shop.isDefault} onChange={(e) => setDefault(e.target.checked)} style={{ width: 20, height: 20 }} />
          <span className="rowCopy"><b>Default shop</b><small>Opens first when you sign in</small></span>
        </label>
        {msg && <p className={msg.ok ? 'hint' : 'formError'}>{msg.ok && <Check size={14} />} {msg.text}</p>}
        {owner && (
          <div className="sheetActions">
            <button type="button" className="btn danger" onClick={remove}>Delete shop</button>
            <button className="btn">Save details</button>
          </div>
        )}
      </form>
    </section>
  )
}

function Shops() {
  const { shops, shop, selectShop, reloadShops } = useSession()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const { shop: created } = await api<{ shop: Shop }>('/shops', 'POST', { name: name.trim() })
      await reloadShops()
      selectShop(created.id)
      setName('')
      setError('')
    } catch (err) {
      setError(errMsg(err))
    }
  }
  return (
    <section>
      <div className="sectionHead"><h2>Your shops</h2><span className="count">{shops.length}</span></div>
      <div className="list">
        {shops.map((s) => (
          <button className="row" key={s.id} onClick={() => selectShop(s.id)} style={{ minHeight: 56 }}>
            <span className="iconTile soft"><Store size={18} strokeWidth={1.7} /></span>
            <span className="rowCopy"><b>{s.name}</b><small>{[s.isDefault && 'Default', s.role === 'owner' ? 'Owner' : 'Member'].filter(Boolean).join(' · ')}</small></span>
            {s.id === shop?.id && <span className="chip muted">Viewing</span>}
          </button>
        ))}
      </div>
      <form className="addRow mt" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New shop name" maxLength={60} aria-label="New shop name" />
        <button className="plus" aria-label="Create shop"><Plus size={20} /></button>
      </form>
      <p className="hint">New shops start with the default categories and partners. Records are never shared between shops.</p>
      {error && <p className="formError">{error}</p>}
    </section>
  )
}

function AppSection() {
  const { user, logout } = useSession()
  const { queue } = useSync()
  const confirm = useConfirm()
  const { canInstall, install } = useInstallPrompt()
  const [standalone, setStandalone] = useState(isStandalone)
  useEffect(() => {
    const mq = matchMedia('(display-mode: standalone)')
    const on = () => setStandalone(isStandalone())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const signOut = async () => {
    if (queue.length) {
      const ok = await confirm({
        title: 'Sign out with unsynced changes?',
        message: `${queue.length} change${queue.length === 1 ? '' : 's'} on this device haven’t reached the server yet and will be lost if you sign out now.`,
        confirm: 'Sign out anyway',
      })
      if (!ok) return
    }
    await logout()
  }

  return (
    <section>
      <div className="sectionHead"><h2>App</h2></div>
      {!standalone && (canInstall ? (
        <button className="btn secondary block" onClick={install}><Download size={18} /> Install Frozen Shake app</button>
      ) : isIOS() ? (
        <div className="note" style={{ marginTop: 0 }}><Smartphone size={20} /><span>To install on iPhone or iPad: tap the Share button in Safari, then “Add to Home Screen”.</span></div>
      ) : null)}
      <div className="note">
        <Smartphone size={20} style={{ flex: 'none' }} />
        <span>Entries are saved to your account and synced across devices. If you’re offline, they’re kept on this device and sent automatically when you reconnect.</span>
      </div>
      <div className="list mt">
        <div className="row">
          <span className="iconTile soft"><User size={18} strokeWidth={1.7} /></span>
          <span className="rowCopy"><b>{user?.name || 'Signed in'}</b><small>{user?.email}</small></span>
          <button className="pill" onClick={signOut}><LogOut size={14} style={{ verticalAlign: -2 }} /> Sign out</button>
        </div>
      </div>
    </section>
  )
}
