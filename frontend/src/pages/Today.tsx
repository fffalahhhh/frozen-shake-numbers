import { useState } from 'react'
import { Link } from 'react-router'
import { Banknote, CalendarClock, CirclePlus, Forward, ReceiptText, TrendingUp, Wallet } from 'lucide-react'
import { useFetch, type Category, type Expense, type Handover, type Partner, type Revenue, type Shop, type Totals } from '../api'
import { useSession } from '../session'
import { applyOps, applyRevenueOps, overlayOps, useSync } from '../sync'
import { addDays, dayOfMonth, fmtDate, inr, monthBounds, newestFirst, sum, toPaise, todayIn } from '../lib'
import { Empty, Skeleton, Status } from '../ui'
import { RevenueSheet, TxnSheet } from '../sheets'

const RECENT_REVENUE = 7
const RECENT_EXPENSES = 10

type SheetState = null | { type: 'revenue'; date: string } | { type: 'expense'; item?: Expense; prefill?: { refId: string; amount: string } } | { type: 'handover' }

/** "Today" / "Yesterday" / "Friday", plus the date. */
export function dayLabel(date: string, today: string): [string, string] {
  const name = date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : fmtDate(date, { weekday: 'long' })
  return [name, fmtDate(date, { day: 'numeric', month: 'short', year: 'numeric' })]
}

export default function Home() {
  const shop = useSession().shop as Shop
  const today = todayIn(shop.timezone)
  const [sheet, setSheet] = useState<SheetState>(null)
  useSync() // re-render when queued changes come and go

  const base = `/shops/${shop.id}`
  const rev = useFetch<{ revenue: Revenue[] }>(`${base}/revenue?limit=${RECENT_REVENUE}`)
  const exp = useFetch<{ items: Expense[] }>(`${base}/expenses?limit=${RECENT_EXPENSES}`)
  const ho = useFetch<{ items: Handover[] }>(`${base}/handovers?limit=10`) // only to reflect unsynced handovers in the totals
  const cats = useFetch<{ categories: Category[] }>(`${base}/categories`)
  const parts = useFetch<{ partners: Partner[] }>(`${base}/partners`)
  const summary = useFetch<{ summary: Totals; since: string | null }>(`${base}/summary`)
  const [monthStart, monthEnd] = monthBounds(today)
  const monthExp = useFetch<{ items: Expense[] }>(`${base}/expenses?from=${monthStart}&to=${monthEnd}`)

  const revenues = applyRevenueOps(rev.data?.revenue ?? [], overlayOps(shop.id, 'revenue', rev.loadedAt))
  const expenses = applyOps(exp.data?.items ?? [], overlayOps(shop.id, 'expense', exp.loadedAt), () => true).sort(newestFirst)
  const handovers = applyOps(ho.data?.items ?? [], overlayOps(shop.id, 'handover', ho.loadedAt), () => true)

  // All-time totals from the server, adjusted for changes that haven't synced yet.
  const all = summary.data?.summary
  const allRevenue = toPaise(all?.revenue) + sum(revenues) - sum(rev.data?.revenue ?? [])
  const allExpenses = toPaise(all?.expenses) + sum(expenses) - sum(exp.data?.items ?? [])
  const allHandovers = toPaise(all?.handovers) + sum(handovers) - sum(ho.data?.items ?? [])
  const cash = allRevenue - allExpenses - allHandovers

  // A monthly due is paid once any expense in its category is dated this month.
  const paid = new Set(applyOps(monthExp.data?.items ?? [], overlayOps(shop.id, 'expense', monthExp.loadedAt),
    (e) => e.date >= monthStart && e.date <= monthEnd).map((e) => e.categoryId))
  const dues = !monthExp.data ? [] : (cats.data?.categories ?? [])
    .filter((c) => c.active && c.dueDay && c.dueAmount && !paid.has(c.id))
    .map((c) => ({ ...c, due: dayOfMonth(today, c.dueDay!) }))
    .sort((a, b) => a.due.localeCompare(b.due))
  const since = summary.data?.since
  const offline = [rev, exp, summary].some((f) => f.error?.status === 0 && !f.data)

  return (
    <>
      <header className="pageHead">
        <div className="eyebrow">{shop.name}</div>
        <h1>Cash book</h1>
        <p>All-time cash in hand and your latest entries.</p>
      </header>

      {offline && <div className="banner warn"><span className="grow">You’re offline and nothing is saved on this device yet. New entries will sync when you’re back online.</span></div>}

      <div className="todayGrid">
        <div className="side">
          <section className="hero" aria-label="All-time cash summary">
            <div className="top">
              <span>
                <span className="label">Cash in hand</span>
                <small className="since">{since ? `All time · since ${fmtDate(since, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'All time'}</small>
              </span>
              <span className="wallet"><Wallet size={22} strokeWidth={1.7} /></span>
            </div>
            <strong className={cash < 0 ? 'neg' : ''}>{inr(cash)}</strong>
            <div className="heroCards">
              <div><span>Revenue</span><b>{inr(allRevenue)}</b></div>
              <div><span>Expenses</span><b>{inr(allExpenses)}</b></div>
              <div><span>Handed over</span><b>{inr(allHandovers)}</b></div>
            </div>
          </section>

          <div className="actions">
            <button className="action" onClick={() => setSheet({ type: 'revenue', date: today })}><i><TrendingUp size={21} strokeWidth={1.8} /></i>Add revenue</button>
            <button className="action" onClick={() => setSheet({ type: 'expense' })}><i><CirclePlus size={21} strokeWidth={1.8} /></i>Add expense</button>
            <button className="action" onClick={() => setSheet({ type: 'handover' })}><i><Forward size={21} strokeWidth={1.8} /></i>Hand over</button>
          </div>

          {dues.length > 0 && (
            <>
              <div className="sectionHead"><h2>Dues this month</h2><span className="count">{dues.length}</span></div>
              <div className="list">
                {dues.map((c) => (
                  <button className="row" key={c.id} onClick={() => setSheet({ type: 'expense', prefill: { refId: c.id, amount: c.dueAmount! } })}>
                    <span className="iconTile warm"><CalendarClock size={19} strokeWidth={1.7} /></span>
                    <span className="rowCopy">
                      <b>{c.name}{c.due < today && <span className="chip danger">Overdue</span>}</b>
                      <small>{c.due === today ? 'Due today' : `Due ${fmtDate(c.due, { weekday: 'short', day: 'numeric', month: 'short' })}`} · Tap to pay</small>
                    </span>
                    <span className="amount">{inr(toPaise(c.dueAmount))}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div>
          <div className="sectionHead">
            <h2>Recent revenue</h2>
            <Link className="link" to="/history">See all</Link>
          </div>
          {rev.loading && !rev.data ? <Skeleton rows={2} /> : revenues.length === 0
            ? <Empty icon={Banknote} title="No revenue yet" text="Tap Add revenue to record today’s total cash sales." />
            : (
              <div className="list">
                {revenues.slice(0, RECENT_REVENUE).map((r) => {
                  const [name, date] = dayLabel(r.date, today)
                  return (
                    <button className="row" key={r.date} onClick={() => setSheet({ type: 'revenue', date: r.date })}>
                      <span className="iconTile"><Banknote size={20} strokeWidth={1.7} /></span>
                      <span className="rowCopy"><b>{name}<Status item={r} /></b><small>{date}</small></span>
                      <span className="amount pos">{inr(toPaise(r.amount))}</span>
                    </button>
                  )
                })}
              </div>
            )}

          <div className="sectionHead">
            <h2>Recent expenses</h2>
            <Link className="link" to="/history">See all</Link>
          </div>
          {exp.loading && !exp.data ? <Skeleton /> : expenses.length === 0
            ? <Empty icon={ReceiptText} title="No expenses yet" text="Add shop stock, utilities or another expense to keep your cash total accurate." />
            : (
              <div className="list">
                {expenses.slice(0, RECENT_EXPENSES).map((e) => (
                  <button className="row" key={e.id} onClick={() => setSheet({ type: 'expense', item: e })}>
                    <span className="iconTile soft"><ReceiptText size={19} strokeWidth={1.7} /></span>
                    <span className="rowCopy">
                      <b>{e.categoryName}<Status item={e} /></b>
                      <small>{dayLabel(e.date, today)[0]}, {fmtDate(e.date, { day: 'numeric', month: 'short' })}{e.note ? ` · ${e.note}` : ''}</small>
                    </span>
                    <span className="amount">−{inr(toPaise(e.amount))}</span>
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>

      {sheet?.type === 'revenue' && <RevenueSheet shop={shop} date={sheet.date} onClose={() => setSheet(null)} />}
      {sheet?.type === 'expense' && (
        <TxnSheet kind="expense" shop={shop} date={today} item={sheet.item} prefill={sheet.prefill} options={cats.data?.categories ?? []} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === 'handover' && (
        <TxnSheet kind="handover" shop={shop} date={today} options={parts.data?.partners ?? []} onClose={() => setSheet(null)} />
      )}
    </>
  )
}
