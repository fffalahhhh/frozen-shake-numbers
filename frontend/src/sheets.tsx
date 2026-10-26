import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { useFetch, type Category, type Expense, type Handover, type Partner, type Revenue, type Shop } from './api'
import { inr, isAmount, toPaise, todayIn, uuid } from './lib'
import { enqueue, overlayOps } from './sync'
import { DateField, MoneyInput, Sheet, useConfirm, type SheetHandle } from './ui'

/** Set the day's revenue total. Picking a date loads that day's current total. */
export function RevenueSheet({ shop, date: initial, onClose }: { shop: Shop; date: string; onClose: () => void }) {
  const sheet = useRef<SheetHandle>(null)
  const today = todayIn(shop.timezone)
  const [date, setDate] = useState(initial)
  const [amount, setAmount] = useState('')
  const [typed, setTyped] = useState(false)
  const [error, setError] = useState('')
  const existing = useFetch<{ revenue: Revenue[] }>(`/shops/${shop.id}/revenue?from=${date}&to=${date}`)
  const pending = overlayOps(shop.id, 'revenue', existing.loadedAt).filter((o) => o.targetId === date).at(-1)
  const current: string | undefined = pending?.body?.amount ?? existing.data?.revenue[0]?.amount

  // Prefill with the chosen day's total until the user types their own amount.
  useEffect(() => {
    if (!typed) setAmount(current && toPaise(current) ? String(Number(current)) : '')
  }, [current, typed])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!isAmount(amount)) return setError('Enter an amount like 4000 or 4000.50')
    enqueue({ shopId: shop.id, kind: 'revenue', action: 'put', targetId: date, body: { amount: amount.trim() } })
    sheet.current?.dismiss()
  }
  return (
    <Sheet ref={sheet} open onClose={onClose} title="Daily revenue">
      <form onSubmit={submit}>
        <label className="field">
          <span>Total cash sales</span>
          <MoneyInput value={amount} onChange={(v) => { setTyped(true); setAmount(v) }} autoFocus />
        </label>
        <label className="field">
          <span>Date</span>
          <DateField value={date} max={today} onChange={setDate} />
          <p className="hint">{current !== undefined ? `This day already has ${inr(toPaise(current))}. Saving replaces it.` : 'One total for the day.'}</p>
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
  prefill?: { refId: string; amount: string }
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
  const [note, setNote] = useState(item?.note ?? '')
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
    const body = { date, amount: amount.trim(), note: note.trim(), [`${refKey}Id`]: refId, [`${refKey}Name`]: refName }
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
