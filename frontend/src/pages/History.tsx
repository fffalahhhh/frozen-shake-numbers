import { useState } from 'react'
import { useNavigate } from 'react-router'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useFetch, type HistoryDay, type Shop } from '../api'
import { useSession } from '../session'
import { addMonths, fmtDate, inr, monthBounds, toPaise, todayIn } from '../lib'
import { DateField, Empty, PageHead, Skeleton } from '../ui'
import { dayLabel } from './Today'

type Totals = { revenue: string; expenses: string; handovers: string; net: string; openingBalance: string; closingBalance: string }
type Mode = 'all' | 'month' | 'range'

export default function History() {
  const shop = useSession().shop as Shop
  const navigate = useNavigate()
  const today = todayIn(shop.timezone)
  const thisMonth = monthBounds(today)[0]
  const [mode, setMode] = useState<Mode>('all')
  const [month, setMonth] = useState(thisMonth)
  const [range, setRange] = useState({ from: thisMonth, to: today })

  const [from, to] = mode === 'all' ? ['2000-01-01', today] : mode === 'month' ? monthBounds(month) : [range.from, range.to]
  const { data, loading, error, reload } = useFetch<{ days: HistoryDay[]; totals: Totals }>(`/shops/${shop.id}/history?from=${from}&to=${to}`)
  const days = data?.days ?? []

  return (
    <>
      <PageHead eyebrow="Your records" title="History" sub="Every day you’ve recorded. Open a day to see and edit all of its entries." />

      <div className="seg" role="tablist">
        {([['all', 'All'], ['month', 'By month'], ['range', 'Date range']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{label}</button>
        ))}
      </div>

      {mode === 'month' && (
        <div className="monthBar">
          <button className="iconBtn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft size={20} /></button>
          <b>{fmtDate(month, { month: 'long', year: 'numeric' })}</b>
          <button className="iconBtn" onClick={() => setMonth(addMonths(month, 1))} disabled={month >= thisMonth} aria-label="Next month"><ChevronRight size={20} /></button>
        </div>
      )}
      {mode === 'range' && (
        <div className="rangeRow">
          <label className="field"><span>From</span><DateField value={range.from} max={range.to} onChange={(d) => setRange({ ...range, from: d })} label="From" /></label>
          <label className="field"><span>To</span><DateField value={range.to} min={range.from} max={today} onChange={(d) => setRange({ ...range, to: d })} label="To" /></label>
        </div>
      )}

      {data && days.length > 0 && (
        <div className="totals">
          <div><span>Revenue</span><b>{inr(toPaise(data.totals.revenue))}</b></div>
          <div><span>Expenses</span><b>{inr(toPaise(data.totals.expenses))}</b></div>
          <div><span>Handed over</span><b>{inr(toPaise(data.totals.handovers))}</b></div>
          <div><span>{mode === 'all' ? 'Cash in hand' : 'In hand at end'}</span><b>{inr(toPaise(data.totals.closingBalance))}</b></div>
        </div>
      )}

      <div className="sectionHead"><p className="hint" style={{ margin: 0 }}>{days.length} {days.length === 1 ? 'day' : 'days'} recorded · In hand is the running balance</p></div>

      {error && !data ? (
        <div className="banner danger"><span className="grow">{error.status === 0 ? 'You’re offline and this period isn’t saved on this device yet.' : error.message}</span><button className="pill" onClick={reload}>Retry</button></div>
      ) : loading && !data ? <Skeleton rows={4} /> : days.length === 0 ? (
        <Empty icon={CalendarDays} title="Your history starts here" text="Each day you record revenue, expenses or a partner handover will appear here." />
      ) : (
        <>
          <div className="histHead"><span>Date</span><span className="figs"><span>Revenue</span><span>Expenses</span><span>Handed over</span><span>In hand</span></span></div>
          <div className="list">
            {days.map((d) => {
              const [name, date] = dayLabel(d.date, today)
              return (
                <button key={d.date} className="row histRow" onClick={() => navigate(`/history/${d.date}`)}>
                  <span className="iconTile soft"><CalendarDays size={19} strokeWidth={1.7} /></span>
                  <span className="rowCopy">
                    <b>{name}, {date}</b>
                    <small className="sumLine">In {inr(toPaise(d.revenue))} · Spent {inr(toPaise(d.expenses))}{toPaise(d.handovers) ? ` · Out ${inr(toPaise(d.handovers))}` : ''}</small>
                  </span>
                  <span className="figs">
                    <span>{inr(toPaise(d.revenue))}</span><span>{inr(toPaise(d.expenses))}</span><span>{inr(toPaise(d.handovers))}</span>
                  </span>
                  <span className={'amount' + (toPaise(d.balance) >= 0 ? ' pos' : '')}>{inr(toPaise(d.balance))}</span>
                  <ChevronRight className="chev" size={16} />
                </button>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}
