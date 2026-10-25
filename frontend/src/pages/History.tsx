import { useState } from 'react'
import { useNavigate } from 'react-router'
import { CalendarDays, ChevronLeft, ChevronRight, ChevronRight as Open } from 'lucide-react'
import { useFetch, type HistoryDay, type Shop } from '../api'
import { useSession } from '../session'
import { addMonths, fmtDate, inr, monthBounds, toPaise, todayIn } from '../lib'
import { Empty, PageHead, Skeleton } from '../ui'

type Totals = Omit<HistoryDay, 'date'>

export default function History() {
  const shop = useSession().shop as Shop
  const navigate = useNavigate()
  const today = todayIn(shop.timezone)
  const [month, setMonth] = useState(() => monthBounds(today)[0])
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const [draft, setDraft] = useState({ from: monthBounds(today)[0], to: today })

  const [from, to] = custom ? [custom.from, custom.to] : monthBounds(month)
  const { data, loading, error, reload } = useFetch<{ days: HistoryDay[]; totals: Totals }>(`/shops/${shop.id}/history?from=${from}&to=${to}`)
  const days = data?.days ?? []
  const thisMonth = monthBounds(today)[0]

  return (
    <>
      <PageHead eyebrow="Your records" title="History" sub="Review a day and open it to make changes." />

      <div className="seg" role="tablist">
        <button className={custom ? '' : 'on'} onClick={() => setCustom(null)}>By month</button>
        <button className={custom ? 'on' : ''} onClick={() => setCustom(draft)}>Date range</button>
      </div>

      {custom ? (
        <form className="rangeRow" onSubmit={(e) => { e.preventDefault(); if (draft.from <= draft.to) setCustom(draft) }}>
          <label className="field"><span>From</span><input type="date" value={draft.from} max={draft.to} onChange={(e) => setDraft({ ...draft, from: e.target.value })} required /></label>
          <label className="field"><span>To</span><input type="date" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} required /></label>
          <button className="btn" style={{ minHeight: 44 }}>Show</button>
        </form>
      ) : (
        <div className="monthBar">
          <button className="iconBtn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft size={20} /></button>
          <b>{fmtDate(month, { month: 'long', year: 'numeric' })}</b>
          <button className="iconBtn" onClick={() => setMonth(addMonths(month, 1))} disabled={month >= thisMonth} aria-label="Next month"><ChevronRight size={20} /></button>
        </div>
      )}

      {data && days.length > 0 && (
        <div className="totals">
          <div><span>Revenue</span><b>{inr(toPaise(data.totals.revenue))}</b></div>
          <div><span>Expenses</span><b>{inr(toPaise(data.totals.expenses))}</b></div>
          <div><span>Handed over</span><b>{inr(toPaise(data.totals.handovers))}</b></div>
          <div><span>Cash in hand</span><b>{inr(toPaise(data.totals.cashInHand))}</b></div>
        </div>
      )}

      <div className="sectionHead"><p className="hint" style={{ margin: 0 }}>{days.length} {days.length === 1 ? 'day' : 'days'} recorded</p></div>

      {error && !data ? (
        <div className="banner danger"><span className="grow">{error.status === 0 ? 'You’re offline and this period isn’t saved on this device yet.' : error.message}</span><button className="pill" onClick={reload}>Retry</button></div>
      ) : loading && !data ? <Skeleton rows={4} /> : days.length === 0 ? (
        <Empty icon={CalendarDays} title="Your history starts here" text="Each day you record revenue, expenses or a partner handover will appear here." />
      ) : (
        <>
          <div className="histHead"><span>Date</span><span className="figs"><span>Revenue</span><span>Expenses</span><span>Handed over</span><span>Cash in hand</span></span></div>
          <div className="list">
            {days.map((d) => (
              <button key={d.date} className="row histRow" onClick={() => navigate(d.date === today ? '/' : `/?date=${d.date}`)}>
                <span className="iconTile soft"><CalendarDays size={19} strokeWidth={1.7} /></span>
                <span className="rowCopy">
                  <b>{fmtDate(d.date)}</b>
                  <small className="sumLine">In {inr(toPaise(d.revenue))} · Spent {inr(toPaise(d.expenses))} · Out {inr(toPaise(d.handovers))}</small>
                </span>
                <span className="figs">
                  <span>{inr(toPaise(d.revenue))}</span><span>{inr(toPaise(d.expenses))}</span><span>{inr(toPaise(d.handovers))}</span>
                </span>
                <span className={'amount' + (toPaise(d.cashInHand) >= 0 ? ' pos' : '')}>{inr(toPaise(d.cashInHand))}</span>
                <Open size={16} color="var(--muted)" />
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}
