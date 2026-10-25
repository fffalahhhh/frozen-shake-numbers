import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { Banknote, ChevronLeft, ChevronRight, Forward, ReceiptText, Users } from 'lucide-react'
import { useFetch, type Category, type Expense, type Handover, type Partner, type Revenue, type Shop } from '../api'
import { useSession } from '../session'
import { applyOps, applyRevenueOps, overlayOps, useSync } from '../sync'
import { addDays, inr, newestFirst, sum, toPaise, todayIn } from '../lib'
import { Empty, openPicker, Skeleton, Status } from '../ui'
import { RevenueSheet, TxnSheet } from '../sheets'
import { dayLabel } from './Today'

type SheetState = null | { type: 'revenue' } | { type: 'expense'; item?: Expense } | { type: 'handover'; item?: Handover }

/** Every entry for one date, opened from History. */
export default function Day() {
  const shop = useSession().shop as Shop
  const { date = '' } = useParams()
  const navigate = useNavigate()
  const today = todayIn(shop.timezone)
  const [sheet, setSheet] = useState<SheetState>(null)
  useSync()

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date)
  const base = `/shops/${shop.id}`
  const range = `?from=${date}&to=${date}`
  const rev = useFetch<{ revenue: Revenue[] }>(valid ? `${base}/revenue${range}` : null)
  const exp = useFetch<{ items: Expense[] }>(valid ? `${base}/expenses${range}` : null)
  const ho = useFetch<{ items: Handover[] }>(valid ? `${base}/handovers${range}` : null)
  const cats = useFetch<{ categories: Category[] }>(`${base}/categories`)
  const parts = useFetch<{ partners: Partner[] }>(`${base}/partners`)
  if (!valid) return <Navigate to="/history" replace />

  const revenue = applyRevenueOps(rev.data?.revenue ?? [], overlayOps(shop.id, 'revenue', rev.loadedAt)).find((r) => r.date === date)
  const expenses = applyOps(exp.data?.items ?? [], overlayOps(shop.id, 'expense', exp.loadedAt), (i) => i.date === date).sort(newestFirst)
  const handovers = applyOps(ho.data?.items ?? [], overlayOps(shop.id, 'handover', ho.loadedAt), (i) => i.date === date).sort(newestFirst)
  const loading = [rev, exp, ho].some((f) => f.loading && !f.data)
  const offline = [rev, exp, ho].some((f) => f.error?.status === 0 && !f.data)
  const go = (d: string) => navigate(`/history/${d}`, { replace: true })
  const [name, full] = dayLabel(date, today)

  return (
    <div className="push">
      <Link to="/history" className="backLink"><ChevronLeft size={22} strokeWidth={2.2} />History</Link>

      <div className="dateBar">
        <button className="iconBtn" onClick={() => go(addDays(date, -1))} aria-label="Previous day"><ChevronLeft size={20} /></button>
        <label className="center">
          <b>{name}</b>
          <small>{full}</small>
          <input type="date" value={date} max={today} onClick={openPicker} onChange={(e) => e.target.value && go(e.target.value)} aria-label="Choose date" />
        </label>
        <button className="iconBtn" onClick={() => go(addDays(date, 1))} disabled={date >= today} aria-label="Next day"><ChevronRight size={20} /></button>
      </div>

      {offline && <div className="banner warn"><span className="grow">You’re offline and this day isn’t saved on this device yet. Anything you add will sync later.</span></div>}

      <div className="totals" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div><span>Revenue</span><b>{inr(toPaise(revenue?.amount))}</b></div>
        <div><span>Spent</span><b>{inr(sum(expenses))}</b></div>
        <div><span>Handed over</span><b>{inr(sum(handovers))}</b></div>
      </div>

      <div className="sectionHead"><h2>Revenue</h2></div>
      {loading ? <Skeleton rows={1} /> : (
        <div className="list">
          <button className="row" onClick={() => setSheet({ type: 'revenue' })}>
            <span className="iconTile"><Banknote size={20} strokeWidth={1.7} /></span>
            <span className="rowCopy">
              <b>Cash sales{revenue && <Status item={revenue} />}</b>
              <small>{revenue ? 'One total for the day' : 'Not entered · tap to add'}</small>
            </span>
            <span className="amount pos">{inr(toPaise(revenue?.amount))}</span>
          </button>
        </div>
      )}

      <div className="sectionHead">
        <h2>Expenses</h2><span className="count">{expenses.length}</span>
        <button className="link" onClick={() => setSheet({ type: 'expense' })}>Add</button>
      </div>
      {loading ? <Skeleton /> : expenses.length === 0
        ? <Empty icon={ReceiptText} title="No expenses on this day" text="Tap Add to record one for this date." />
        : (
          <div className="list">
            {expenses.map((e) => (
              <button className="row" key={e.id} onClick={() => setSheet({ type: 'expense', item: e })}>
                <span className="iconTile soft"><ReceiptText size={19} strokeWidth={1.7} /></span>
                <span className="rowCopy"><b>{e.categoryName}<Status item={e} /></b><small>{e.note || 'No note'}</small></span>
                <span className="amount">−{inr(toPaise(e.amount))}</span>
              </button>
            ))}
          </div>
        )}

      <div className="sectionHead">
        <h2>Partner handovers</h2><span className="count">{handovers.length}</span>
        <button className="link" onClick={() => setSheet({ type: 'handover' })}>Add</button>
      </div>
      {loading ? <Skeleton rows={1} /> : handovers.length === 0
        ? <Empty icon={Users} title="No handovers on this day" text="Cash given to a partner is taken out of cash in hand, not counted as an expense." />
        : (
          <div className="list">
            {handovers.map((h) => (
              <button className="row" key={h.id} onClick={() => setSheet({ type: 'handover', item: h })}>
                <span className="iconTile warm"><Forward size={19} strokeWidth={1.7} /></span>
                <span className="rowCopy"><b>{h.partnerName}<Status item={h} /></b><small>{h.note || 'Cash handed over'}</small></span>
                <span className="amount">−{inr(toPaise(h.amount))}</span>
              </button>
            ))}
          </div>
        )}

      {sheet?.type === 'revenue' && <RevenueSheet shop={shop} date={date} onClose={() => setSheet(null)} />}
      {sheet?.type === 'expense' && (
        <TxnSheet kind="expense" shop={shop} date={date} item={sheet.item} options={cats.data?.categories ?? []} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === 'handover' && (
        <TxnSheet kind="handover" shop={shop} date={date} item={sheet.item} options={parts.data?.partners ?? []} onClose={() => setSheet(null)} />
      )}
    </div>
  )
}
