import { useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import type { Category, Expense, Handover, Partner, Shop } from './api'
import { fmtDate, isAmount, toPaise, uuid } from './lib'
import { enqueue } from './sync'
import { MoneyInput, Sheet, useConfirm } from './ui'

export function RevenueSheet({ shop, date, current, onClose }: { shop: Shop; date: string; current?: string; onClose: () => void }) {
  const [amount, setAmount] = useState(current && toPaise(current) ? String(Number(current)) : '')
  const [error, setError] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!isAmount(amount)) return setError('Enter an amount like 4000 or 4000.50')
    enqueue({ shopId: shop.id, kind: 'revenue', action: 'put', targetId: date, body: { amount: amount.trim() } })
    onClose()
  }
  return (
    <Sheet open onClose={onClose} title="Daily revenue">
      <form onSubmit={submit}>
        <label className="field">
          <span>Total cash sales · {fmtDate(date)}</span>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
          <p className="hint">One total for the day. Saving again replaces it.</p>
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
} & (
  | { kind: 'expense'; item?: Expense; options: Category[] }
  | { kind: 'handover'; item?: Handover; options: Partner[] }
)

/** Add / edit / delete an expense or a partner handover. */
export function TxnSheet(props: TxnProps) {
  const { shop, kind, item, options, onClose } = props
  const confirm = useConfirm()
  const refKey = kind === 'expense' ? 'category' : 'partner'
  const currentRef = item ? (kind === 'expense' ? (item as Expense).categoryId : (item as Handover).partnerId) : ''
  // Hidden categories / inactive partners stay selectable for records that already use them.
  const choices = options.filter((o) => o.active || o.id === currentRef)
  const [refId, setRefId] = useState(currentRef || (kind === 'handover' ? '' : choices[0]?.id ?? ''))
  const [amount, setAmount] = useState(item ? String(Number(item.amount)) : '')
  const [note, setNote] = useState(item?.note ?? '')
  const [date, setDate] = useState(item?.date ?? props.date)
  const [error, setError] = useState('')
  const label = kind === 'expense' ? 'Category' : 'Partner'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!isAmount(amount) || toPaise(amount) <= 0) return setError('Enter an amount more than ₹0, like 250 or 250.50')
    if (!refId) return setError(`Choose a ${label.toLowerCase()}`)
    if (!date) return setError('Choose a date')
    const ref = choices.find((c) => c.id === refId)!
    // Keep the original snapshot name when the reference didn't change (matches the server).
    const refName = item && refId === currentRef ? (item as any)[`${refKey}Name`] : ref.name
    const body = { date, amount: amount.trim(), note: note.trim(), [`${refKey}Id`]: refId, [`${refKey}Name`]: refName }
    enqueue(item
      ? { shopId: shop.id, kind, action: 'update', targetId: item.id, body }
      : { shopId: shop.id, kind, action: 'create', targetId: uuid(), body: { ...body, createdAt: new Date().toISOString() } })
    onClose()
  }

  const remove = async () => {
    const ok = await confirm({
      title: kind === 'expense' ? 'Delete this expense?' : 'Delete this handover?',
      message: 'This removes it from the day and updates cash in hand. You can’t undo this.',
    })
    if (!ok || !item) return
    enqueue({ shopId: shop.id, kind, action: 'delete', targetId: item.id })
    onClose()
  }

  const title = kind === 'expense' ? (item ? 'Edit expense' : 'Add expense') : item ? 'Edit handover' : 'Hand over cash'
  return (
    <Sheet open onClose={onClose} title={title}>
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
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
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
