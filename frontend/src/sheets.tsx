import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { useFetch, type CashCount, type Category, type Expense, type Handover, type Partner, type Revenue, type Shop } from './api'
import { fromPaise, inr, isAmount, part, toPaise, todayIn, uuid, type Method } from './lib'
import { enqueue, overlayOps } from './sync'
import { DateField, MethodSeg, MoneyInput, Sheet, useConfirm, type SheetHandle } from './ui'

/** Set the day's revenue, split into cash and online. Picking a date loads that day's current figures. */
export function RevenueSheet({ shop, date: initial, onClose }: { shop: Shop; date: string; onClose: () => void }) {
  const sheet = useRef<SheetHandle>(null)
  const today = todayIn(shop.timezone)
  const [date, setDate] = useState(initial)
  const [cash, setCash] = useState('')
  const [online, setOnline] = useState('')
  const [typed, setTyped] = useState(false)
  const [error, setError] = useState('')
  const existing = useFetch<{ revenue: Revenue[] }>(`/shops/${shop.id}/revenue?from=${date}&to=${date}`)
  const pending = overlayOps(shop.id, 'revenue', existing.loadedAt).filter((o) => o.targetId === date).at(-1)
  const current: Partial<Revenue> | undefined = (pending?.body as Revenue | undefined) ?? existing.data?.revenue[0]
  const curCash = current ? part(current as Revenue, 'cash') : 0
  const curOnline = current ? part(current as Revenue, 'online') : 0

  // Prefill with the chosen day's figures until the user types their own.
  useEffect(() => {
    if (typed) return
    setCash(curCash ? String(curCash / 100) : '')
    setOnline(curOnline ? String(curOnline / 100) : '')
  }, [curCash, curOnline, typed])

  const total = (isAmount(cash) ? toPaise(cash) : 0) + (isAmount(online) ? toPaise(online) : 0)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const c = cash.trim() || '0', o = online.trim() || '0'
    if (!cash.trim() && !online.trim()) return setError('Enter the cash or online amount')
    if (!isAmount(c) || !isAmount(o)) return setError('Enter amounts like 4000 or 4000.50')
    enqueue({ shopId: shop.id, kind: 'revenue', action: 'put', targetId: date, body: { cash: c, online: o, amount: fromPaise(total) } })
    sheet.current?.dismiss()
  }
  const type = (set: (v: string) => void) => (v: string) => { setTyped(true); set(v) }
  return (
    <Sheet ref={sheet} open onClose={onClose} title="Daily revenue">
      <form onSubmit={submit}>
        <div className="splitRow">
          <label className="field">
            <span>Cash</span>
            <MoneyInput value={cash} onChange={type(setCash)} autoFocus required={false} label="Cash sales in rupees" />
          </label>
          <label className="field">
            <span>Online</span>
            <MoneyInput value={online} onChange={type(setOnline)} required={false} label="Online sales in rupees" />
          </label>
        </div>
        <p className="hint">Total {inr(total)}</p>
        <label className="field">
          <span>Date</span>
          <DateField value={date} max={today} onChange={setDate} />
          <p className="hint">{current !== undefined ? `This day already has ${inr(curCash)} cash + ${inr(curOnline)} online. Saving replaces it.` : 'One total for the day.'}</p>
        </label>
        {error && <p className="formError">{error}</p>}
        <button className="btn block big">Save revenue</button>
      </form>
    </Sheet>
  )
}

type TxnProps = {
  shop: Shop
  date: string
  onClose: () => void
  prefill?: { refId: string; amount: string; note?: string }
} & (
  | { kind: 'expense'; item?: Expense; options: Category[] }
  | { kind: 'handover'; item?: Handover; options: Partner[] }
)

/** Add / edit / delete an expense or a partner handover. */
export function TxnSheet(props: TxnProps) {
  const { shop, kind, item, options, onClose } = props
  const sheet = useRef<SheetHandle>(null)
  const confirm = useConfirm()
  const refKey = kind === 'expense' ? 'category' : 'partner'
  const currentRef = item ? (kind === 'expense' ? (item as Expense).categoryId : (item as Handover).partnerId) : ''
  // Hidden categories / inactive partners stay selectable for records that already use them.
  const choices = options.filter((o) => o.active || o.id === currentRef)
  const [refId, setRefId] = useState(currentRef || props.prefill?.refId || (kind === 'handover' ? '' : choices[0]?.id ?? ''))
  const [amount, setAmount] = useState(item ? String(Number(item.amount)) : props.prefill ? String(Number(props.prefill.amount)) : '')
  const [method, setMethod] = useState<Method>(item?.method ?? 'cash')
  const [note, setNote] = useState(item?.note ?? props.prefill?.note ?? '')
  const [date, setDate] = useState(item?.date ?? props.date)
  const [error, setError] = useState('')
  const label = kind === 'expense' ? 'Category' : 'Partner'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!isAmount(amount) || toPaise(amount) <= 0) return setError('Enter an amount more than ₹0, like 250 or 250.50')
    if (!refId) return setError(`Choose a ${label.toLowerCase()}`)
    const ref = choices.find((c) => c.id === refId)!
    // Keep the original snapshot name when the reference didn't change (matches the server).
    const refName = item && refId === currentRef ? (item as any)[`${refKey}Name`] : ref.name
    const body = { date, amount: amount.trim(), method, note: note.trim(), [`${refKey}Id`]: refId, [`${refKey}Name`]: refName }
    enqueue(item
      ? { shopId: shop.id, kind, action: 'update', targetId: item.id, body }
      : { shopId: shop.id, kind, action: 'create', targetId: uuid(), body: { ...body, createdAt: new Date().toISOString() } })
    sheet.current?.dismiss()
  }

  const remove = async () => {
    const ok = await confirm({
      title: kind === 'expense' ? 'Delete this expense?' : 'Delete this handover?',
      message: 'It will be removed and cash in hand updated. This can’t be undone.',
      confirm: kind === 'expense' ? 'Delete Expense' : 'Delete Handover',
    })
    if (!ok || !item) return
    enqueue({ shopId: shop.id, kind, action: 'delete', targetId: item.id })
    sheet.current?.dismiss()
  }

  const title = kind === 'expense' ? (item ? 'Edit expense' : 'Add expense') : item ? 'Edit handover' : 'Hand over cash'
  return (
    <Sheet ref={sheet} open onClose={onClose} title={title}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Amount</span>
          <MoneyInput value={amount} onChange={setAmount} autoFocus={!item} />
        </label>
        <div className="field">
          <span>Paid by</span>
          <MethodSeg value={method} onChange={setMethod} />
        </div>
        <label className="field">
          <span>{label}</span>
          <select className="select" value={refId} onChange={(e) => setRefId(e.target.value)} required>
            {kind === 'handover' && <option value="">Choose a partner…</option>}
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Note <small style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</small></span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
            placeholder={kind === 'expense' ? 'For example, fresh fruit and cups' : 'For example, weekly share'} />
        </label>
        <label className="field">
          <span>Date</span>
          <DateField value={date} max={todayIn(shop.timezone)} onChange={setDate} />
        </label>
        {error && <p className="formError">{error}</p>}
        <div className="sheetActions">
          {item && <button type="button" className="btn danger" onClick={remove}><Trash2 size={17} /> Delete</button>}
          <button className="btn big">{item ? 'Save changes' : kind === 'expense' ? 'Add expense' : 'Record handover'}</button>
        </div>
      </form>
    </Sheet>
  )
}

// ponytail: datetime-local uses the device's timezone, assumed to match the shop's.
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** Log, edit or delete a physical cash count. `expected` (paise) is the app's cash in hand, shown for new counts. */
export function CountSheet({ shop, item, expected, onClose }: { shop: Shop; item?: CashCount; expected?: number; onClose: () => void }) {
  const sheet = useRef<SheetHandle>(null)
  const confirm = useConfirm()
  const [amount, setAmount] = useState(item ? String(Number(item.amount)) : '')
  const [at, setAt] = useState(toLocalInput(item?.countedAt ?? new Date().toISOString()))
  const [note, setNote] = useState(item?.note ?? '')
  const [error, setError] = useState('')
  const diff = expected !== undefined && isAmount(amount) ? toPaise(amount) - expected : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!isAmount(amount)) return setError('Enter the amount you counted, like 4200 or 4200.50')
    if (!at) return setError('Choose when you counted')
    const body = { countedAt: new Date(at).toISOString(), amount: amount.trim(), note: note.trim() }
    enqueue(item
      ? { shopId: shop.id, kind: 'count', action: 'update', targetId: item.id, body }
      : { shopId: shop.id, kind: 'count', action: 'create', targetId: uuid(), body })
    sheet.current?.dismiss()
  }

  const remove = async () => {
    const ok = await confirm({ title: 'Delete this count?', message: 'Only the note of what you counted is removed. Cash in hand doesn’t change.', confirm: 'Delete Count' })
    if (!ok || !item) return
    enqueue({ shopId: shop.id, kind: 'count', action: 'delete', targetId: item.id })
    sheet.current?.dismiss()
  }

  return (
    <Sheet ref={sheet} open onClose={onClose} title={item ? 'Edit cash count' : 'Count cash'}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Cash counted</span>
          <MoneyInput value={amount} onChange={setAmount} autoFocus={!item} label="Cash counted in rupees" />
          {expected !== undefined && (
            <p className="hint">
              App says {inr(expected)} cash in hand
              {diff === null ? '' : diff === 0 ? ' · Matches' : ` · ${inr(Math.abs(diff))} ${diff < 0 ? 'short' : 'extra'}`}
            </p>
          )}
        </label>
        <label className="field">
          <span>Counted at</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
        </label>
        <label className="field">
          <span>Note <small style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</small></span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example, before closing" />
        </label>
        {error && <p className="formError">{error}</p>}
        <div className="sheetActions">
          {item && <button type="button" className="btn danger" onClick={remove}><Trash2 size={17} /> Delete</button>}
          <button className="btn big">{item ? 'Save changes' : 'Save count'}</button>
        </div>
      </form>
    </Sheet>
  )
}
