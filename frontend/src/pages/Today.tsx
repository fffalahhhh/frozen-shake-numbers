import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Banknote, ChevronLeft, ChevronRight, CirclePlus, CloudOff, Forward, ReceiptText, TrendingUp, Users, Wallet } from 'lucide-react'
import { useFetch, type Category, type Expense, type Handover, type Partner, type Revenue, type Shop } from '../api'
import { useSession } from '../session'
import { applyOps, overlayOps, useSync } from '../sync'
import { addDays, cashInHand, fmtDate, inr, sum, toPaise, todayIn } from '../lib'
import { Empty, Skeleton } from '../ui'
import { RevenueSheet, TxnSheet } from '../sheets'

type SheetState = null | { type: 'revenue' } | { type: 'expense'; item?: Expense } | { type: 'handover'; item?: Handover }

const newestFirst = (a: { createdAt?: string }, b: { createdAt?: string }) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')

export default function Today() {
  const shop = useSession().shop as Shop
  const [params, setParams] = useSearchParams()
  const today = todayIn(shop.timezone)
  const p = params.get('date')
  const date = p && /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : today
  const setDate = (d: string) => setParams(d === today ? {} : { date: d }, { replace: true })
  const [sheet, setSheet] = useState<SheetState>(null)
  useSync() // re-render when queued changes come and go

  const base = `/shops/${shop.id}`
  const range = `?from=${date}&to=${date}`
  const rev = useFetch<{ revenue: Revenue[] }>(`${base}/revenue${range}`)
  const exp = useFetch<{ items: Expense[] }>(`${base}/expenses${range}`)
  const ho = useFetch<{ items: Handover[] }>(`${base}/handovers${range}`)
  const cats = useFetch<{ categories: Category[] }>(`${base}/categories`)
  const parts = useFetch<{ partners: Partner[] }>(`${base}/partners`)

  const expenses = applyOps(exp.data?.items ?? [], overlayOps(shop.id, 'expense', exp.loadedAt), (i) => i.date === date).sort(newestFirst)
  const handovers = applyOps(ho.data?.items ?? [], overlayOps(shop.id, 'handover', ho.loadedAt), (i) => i.date === date).sort(newestFirst)
  const revOp = overlayOps(shop.id, 'revenue', rev.loadedAt).filter((o) => o.targetId === date).at(-1)
  const revenue = revOp?.body?.amount ?? rev.data?.revenue[0]?.amount
  const revPending = !!revOp && !revOp.syncedAt
  const cash = cashInHand(revenue, expenses, handovers)

  const loading = [rev, exp, ho].some((f) => f.loading && !f.data)
  const offlineMiss = [rev, exp, ho].some((f) => f.error?.status === 0 && !f.data)
  const loadError = [rev, exp, ho].find((f) => f.error && f.error.status !== 0 && !f.data)?.error

  return (
    <>
      <header className="pageHead">
        <div className="eyebrow">{shop.name}</div>
        <h1>Daily book</h1>
        <p>Your sales, spending and cash for the day.</p>
      </header>

      {offlineMiss && (
        <div className="banner warn"><CloudOff size={18} /><span className="grow">You’re offline and this day isn’t saved on this device yet. Anything you add now will sync when you’re back online.</span></div>
      )}
      {loadError && (
        <div className="banner danger"><span className="grow">{loadError.message}</span><button className="pill" onClick={() => [rev, exp, ho].forEach((f) => f.reload())}>Retry</button></div>
      )}

      <div className="todayGrid">
        <div className="side">
          <div className="dateBar">
            <button className="iconBtn" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day"><ChevronLeft size={20} /></button>
            <div className="center">
              <label>
                <b>{fmtDate(date)}</b>
                <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Choose date" />
              </label>
              {date === today
                ? <small>Today · tap the date to change it</small>
                : <small><button className="link" style={{ padding: 0, fontSize: 'inherit', position: 'relative', zIndex: 1 }} onClick={() => setDate(today)}>Tap to return to today</button></small>}
            </div>
            <button className="iconBtn" onClick={() => setDate(addDays(date, 1))} disabled={date >= today} aria-label="Next day"><ChevronRight size={20} /></button>
          </div>

          <section className="hero" aria-label="Daily summary">
            <div className="top">
              <span className="label">Cash in hand</span>
              <span className="wallet"><Wallet size={22} strokeWidth={1.7} /></span>
            </div>
            <strong className={cash < 0 ? 'neg' : ''}>{inr(cash)}</strong>
            <div className="heroCards">
              <div><span>Revenue</span><b>{inr(toPaise(revenue))}</b></div>
              <div><span>Expenses</span><b>{inr(sum(expenses))}</b></div>
              <div><span>Handed over</span><b>{inr(sum(handovers))}</b></div>
            </div>
          </section>

          <div className="actions">
            <button className="action" onClick={() => setSheet({ type: 'revenue' })}><i><TrendingUp size={21} strokeWidth={1.8} /></i>Add revenue</button>
            <button className="action" onClick={() => setSheet({ type: 'expense' })}><i><CirclePlus size={21} strokeWidth={1.8} /></i>Add expense</button>
            <button className="action" onClick={() => setSheet({ type: 'handover' })}><i><Forward size={21} strokeWidth={1.8} /></i>Hand over</button>
          </div>
        </div>

        <div>
          <div className="sectionHead"><h2>Daily revenue</h2></div>
          {loading ? <Skeleton rows={1} /> : (
            <div className="list">
              <button className="row" onClick={() => setSheet({ type: 'revenue' })}>
                <span className="iconTile"><Banknote size={20} strokeWidth={1.7} /></span>
                <span className="rowCopy">
                  <b>Cash sales{revPending && <span className="chip">Pending sync</span>}</b>
                  <small>{revenue === undefined ? 'Not entered yet · tap to add' : 'One total for the day'}</small>
                </span>
                <span className="amount pos">{inr(toPaise(revenue))}</span>
              </button>
            </div>
          )}

          <div className="sectionHead">
            <h2>Expenses</h2><span className="count">{expenses.length}</span>
            <button className="link" onClick={() => setSheet({ type: 'expense' })}>Add</button>
          </div>
          {loading ? <Skeleton /> : expenses.length === 0
            ? <Empty icon={ReceiptText} title="No expenses yet" text="Add shop stock, utilities or another expense to keep your cash total accurate." />
            : (
              <div className="list">
                {expenses.map((e) => (
                  <button className="row" key={e.id} onClick={() => setSheet({ type: 'expense', item: e })}>
                    <span className="iconTile soft"><ReceiptText size={19} strokeWidth={1.7} /></span>
                    <span className="rowCopy">
                      <b>{e.categoryName}<Status item={e} /></b>
                      <small>{e.note || 'No note'}</small>
                    </span>
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
            ? <Empty icon={Users} title="No handovers today" text="When you give cash to a partner, record it here. It’s taken out of cash in hand, not counted as an expense." />
            : (
              <div className="list">
                {handovers.map((h) => (
                  <button className="row" key={h.id} onClick={() => setSheet({ type: 'handover', item: h })}>
                    <span className="iconTile warm"><Forward size={19} strokeWidth={1.7} /></span>
                    <span className="rowCopy">
                      <b>{h.partnerName}<Status item={h} /></b>
                      <small>{h.note || 'Cash handed over'}</small>
                    </span>
                    <span className="amount">−{inr(toPaise(h.amount))}</span>
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>

      {sheet?.type === 'revenue' && <RevenueSheet shop={shop} date={date} current={revenue} onClose={() => setSheet(null)} />}
      {sheet?.type === 'expense' && (
        <TxnSheet kind="expense" shop={shop} date={date} item={sheet.item} options={cats.data?.categories ?? []} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === 'handover' && (
        <TxnSheet kind="handover" shop={shop} date={date} item={sheet.item} options={parts.data?.partners ?? []} onClose={() => setSheet(null)} />
      )}
    </>
  )
}

export function Status({ item }: { item: { pending?: boolean; failed?: boolean } }) {
  if (item.failed) return <span className="chip danger">Not saved</span>
  if (item.pending) return <span className="chip">Pending sync</span>
  return null
}
