import { useState } from 'react'
import { Link } from 'react-router'
import { Banknote, CalendarClock, CirclePlus, Forward, ReceiptText, TrendingUp, Wallet } from 'lucide-react'
import { useFetch, type Category, type Expense, type Handover, type Partner, type Revenue, type Shop, type StaffMember, type Totals } from '../api'
import { useSession } from '../session'
import { applyOps, applyRevenueOps, overlayOps, useSync } from '../sync'
import { addDays, dayOfMonth, fmtDate, inr, monthBounds, newestFirst, part, sumPart, toPaise, todayIn, type Method } from '../lib'
import { Empty, MethodSeg, MethodTag, Skeleton, Status } from '../ui'
import { RevenueSheet, TxnSheet } from '../sheets'

const RECENT_REVENUE = 7
const RECENT_EXPENSES = 10

export const methodLabel = { '': '', cash: 'cash ', online: 'online ' }
export const inHandLabel = { '': 'Total in hand', cash: 'Cash in hand', online: 'Online balance' }

type SheetState = null | { type: 'revenue'; date: string } | { type: 'expense'; item?: Expense; prefill?: { refId: string; amount: string; note?: string } } | { type: 'handover' }

/** "Today" / "Yesterday" / "Friday", plus the date. */
export function dayLabel(date: string, today: string): [string, string] {
  const name = date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : fmtDate(date, { weekday: 'long' })
  return [name, fmtDate(date, { day: 'numeric', month: 'short', year: 'numeric' })]
}

export default function Home() {
  const shop = useSession().shop as Shop
  const today = todayIn(shop.timezone)
  const [sheet, setSheet] = useState<SheetState>(null)
  const [tab, setTab] = useState<Method | ''>('')
  useSync() // re-render when queued changes come and go

  const base = `/shops/${shop.id}`
  const rev = useFetch<{ revenue: Revenue[] }>(`${base}/revenue?limit=${RECENT_REVENUE}`)
  const exp = useFetch<{ items: Expense[] }>(`${base}/expenses?limit=${RECENT_EXPENSES}${tab ? `&method=${tab}` : ''}`)
  const ho = useFetch<{ items: Handover[] }>(`${base}/handovers?limit=10`) // only to reflect unsynced handovers in the totals
  const cats = useFetch<{ categories: Category[] }>(`${base}/categories`)
  const parts = useFetch<{ partners: Partner[] }>(`${base}/partners`)
  const staff = useFetch<{ staff: StaffMember[] }>(`${base}/staff`)
  const summary = useFetch<{ summary: Totals; cash: Totals; online: Totals; since: string | null }>(`${base}/summary`)
  const [monthStart, monthEnd] = monthBounds(today)
  const monthExp = useFetch<{ items: Expense[] }>(`${base}/expenses?from=${monthStart}&to=${monthEnd}`)

  const shown = (x: Parameters<typeof part>[0]) => !tab || part(x, tab) > 0
  const revenues = applyRevenueOps(rev.data?.revenue ?? [], overlayOps(shop.id, 'revenue', rev.loadedAt))
  const expenses = applyOps(exp.data?.items ?? [], overlayOps(shop.id, 'expense', exp.loadedAt), shown).sort(newestFirst)
  const handovers = applyOps(ho.data?.items ?? [], overlayOps(shop.id, 'handover', ho.loadedAt), () => true)

  // All-time totals from the server (for the chosen tab), adjusted for changes that haven't synced yet.
  const all = summary.data?.[tab || 'summary']
  const allRevenue = toPaise(all?.revenue) + sumPart(revenues, tab) - sumPart(rev.data?.revenue ?? [], tab)
  const allExpenses = toPaise(all?.expenses) + sumPart(expenses, tab) - sumPart(exp.data?.items ?? [], tab)
  const allHandovers = toPaise(all?.handovers) + sumPart(handovers, tab) - sumPart(ho.data?.items ?? [], tab)
  const cash = allRevenue - allExpenses - allHandovers

  // A monthly due is paid once any expense in its category is dated this month;
  // a salary once a Salaries expense notes the staff member's name.
  const monthItems = applyOps(monthExp.data?.items ?? [], overlayOps(shop.id, 'expense', monthExp.loadedAt),
    (e) => e.date >= monthStart && e.date <= monthEnd)
  const paid = new Set(monthItems.map((e) => e.categoryId))
  const salaries = cats.data?.categories.find((c) => c.active && /salar/i.test(c.name))
  // ponytail: name match in the note, so "Ali" is also paid by "Alisha"; link expenses to staff if that bites.
  const salaryPaid = (s: StaffMember) => monthItems.some((e) => e.categoryId === salaries?.id && e.note.toLowerCase().includes(s.name.toLowerCase()))
  const dues = !monthExp.data ? [] : [
    ...(cats.data?.categories ?? [])
      .filter((c) => c.active && c.dueDay && c.dueAmount && !paid.has(c.id))
      .map((c) => ({ key: c.id, name: c.name, amount: c.dueAmount!, day: c.dueDay!, prefill: { refId: c.id, amount: c.dueAmount! } })),
    ...(salaries ? staff.data?.staff ?? [] : [])
      .filter((s) => s.active && s.dueDay && s.dueAmount && !salaryPaid(s))
      .map((s) => ({ key: s.id, name: `${s.name} · salary`, amount: s.dueAmount!, day: s.dueDay!, prefill: { refId: salaries!.id, amount: s.dueAmount!, note: s.name } })),
  ].map((d) => ({ ...d, due: dayOfMonth(today, d.day) }))
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
                <span className="label">{inHandLabel[tab]}</span>
                <small className="since">{since ? `All time · since ${fmtDate(since, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'All time'}</small>
              </span>
              <span className="wallet"><Wallet size={22} strokeWidth={1.7} /></span>
            </div>
            <MethodSeg value={tab} onChange={setTab} all />
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
                  <button className="row" key={c.key} onClick={() => setSheet({ type: 'expense', prefill: c.prefill })}>
                    <span className="iconTile warm"><CalendarClock size={19} strokeWidth={1.7} /></span>
                    <span className="rowCopy">
                      <b>{c.name}{c.due < today && <span className="chip danger">Overdue</span>}</b>
                      <small>{c.due === today ? 'Due today' : `Due ${fmtDate(c.due, { weekday: 'short', day: 'numeric', month: 'short' })}`} · Tap to pay</small>
                    </span>
                    <span className="amount">{inr(toPaise(c.amount))}</span>
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
          {rev.loading && !rev.data ? <Skeleton rows={2} /> : revenues.filter(shown).length === 0
            ? <Empty icon={Banknote} title={`No ${methodLabel[tab]}revenue yet`} text="Tap Add revenue to record today’s cash and online sales." />
            : (
              <div className="list">
                {revenues.slice(0, RECENT_REVENUE).filter(shown).map((r) => {
                  const [name, date] = dayLabel(r.date, today)
                  return (
                    <button className="row" key={r.date} onClick={() => setSheet({ type: 'revenue', date: r.date })}>
                      <span className="iconTile"><Banknote size={20} strokeWidth={1.7} /></span>
                      <span className="rowCopy"><b>{name}<Status item={r} /></b><small>{tab ? date : `Cash ${inr(part(r, 'cash'))} · Online ${inr(part(r, 'online'))}`}</small></span>
                      <span className="amount pos">{inr(part(r, tab))}</span>
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
            ? <Empty icon={ReceiptText} title={`No ${methodLabel[tab]}expenses yet`} text="Add shop stock, utilities or another expense to keep your cash total accurate." />
            : (
              <div className="list">
                {expenses.slice(0, RECENT_EXPENSES).map((e) => (
                  <button className="row" key={e.id} onClick={() => setSheet({ type: 'expense', item: e })}>
                    <span className="iconTile soft"><ReceiptText size={19} strokeWidth={1.7} /></span>
                    <span className="rowCopy">
                      <b>{e.categoryName}<MethodTag item={e} /><Status item={e} /></b>
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
