import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { CalendarOff, ChevronLeft, ChevronRight, UserCheck } from 'lucide-react'
import { api, ApiError, useFetch, type Leave, type Shop, type StaffMember } from '../api'
import { useSession } from '../session'
import { addMonths, fmtDate, monthBounds, todayIn } from '../lib'
import { DateField, Empty, PageHead, Sheet, Skeleton, type SheetHandle } from '../ui'

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong')

// Everyone is available every day; a leave marks one person off for one date.
// Leaves are saved straight to the server (online only), like Settings.
export default function Staff() {
  const shop = useSession().shop as Shop
  const today = todayIn(shop.timezone)
  const thisMonth = monthBounds(today)[0]
  const [month, setMonth] = useState(thisMonth)
  const [sheet, setSheet] = useState<StaffMember | null>(null)
  const [error, setError] = useState('')

  const base = `/shops/${shop.id}`
  const [from, to] = monthBounds(month)
  const staff = useFetch<{ staff: StaffMember[] }>(`${base}/staff`)
  const todays = useFetch<{ leaves: Leave[] }>(`${base}/leaves?from=${today}&to=${today}`)
  const monthly = useFetch<{ leaves: Leave[] }>(`${base}/leaves?from=${from}&to=${to}`)
  const reload = () => (todays.reload(), monthly.reload())

  const people = staff.data?.staff ?? []
  const active = people.filter((p) => p.active)
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? 'Former staff'
  const offToday = new Map((todays.data?.leaves ?? []).map((l) => [l.staffId, l]))
  const leaves = monthly.data?.leaves ?? []
  const counts = active.map((p) => [p.name, leaves.filter((l) => l.staffId === p.id).length] as const).filter(([, n]) => n)

  const remove = async (l: Leave) => {
    setError('')
    try {
      await api(`${base}/staff/${l.staffId}/leaves/${l.date}`, 'DELETE')
      reload()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <>
      <PageHead eyebrow="Who’s in" title="Staff" sub="Everyone is available every day unless you record a leave." />

      <div className="sectionHead"><h2>Today</h2><span className="count">{active.length - offToday.size} in</span></div>
      {staff.loading && !staff.data ? <Skeleton rows={2} /> : staff.error && !staff.data ? (
        <div className="banner danger"><span className="grow">{staff.error.status === 0 ? 'You’re offline. Staff and leaves need a connection.' : staff.error.message}</span><button className="pill" onClick={staff.reload}>Retry</button></div>
      ) : active.length === 0 ? (
        <Empty icon={UserCheck} title="No staff yet" text="Add your staff in Settings, then record leaves here." />
      ) : (
        <div className="list">
          {active.map((p) => {
            const off = offToday.get(p.id)
            return (
              <div className="row" key={p.id}>
                <span className={'iconTile ' + (off ? 'warm' : 'soft')}>{off ? <CalendarOff size={19} strokeWidth={1.7} /> : <UserCheck size={19} strokeWidth={1.7} />}</span>
                <span className="rowCopy"><b>{p.name}</b><small>{off ? `On leave${off.note ? ` · ${off.note}` : ''}` : 'Available'}</small></span>
                <button className="pill" onClick={() => setSheet(p)}>Add leave</button>
              </div>
            )
          })}
        </div>
      )}
      {staff.data && active.length > 0 && <p className="hint"><Link className="link" to="/settings">Add or rename staff in Settings</Link></p>}

      <div className="sectionHead"><h2>Leaves</h2><span className="count">{leaves.length}</span></div>
      <div className="monthBar">
        <button className="iconBtn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft size={20} /></button>
        <b>{fmtDate(month, { month: 'long', year: 'numeric' })}</b>
        <button className="iconBtn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRight size={20} /></button>
      </div>
      {error && <p className="formError">{error}</p>}
      {monthly.loading && !monthly.data ? <Skeleton /> : leaves.length === 0 ? (
        <Empty icon={CalendarOff} title="No leaves this month" text="Everyone was available. Tap Add leave next to a name to record a day off." />
      ) : (
        <>
          <div className="list">
            {leaves.map((l) => (
              <div className="row" key={l.staffId + l.date}>
                <span className="iconTile warm"><CalendarOff size={19} strokeWidth={1.7} /></span>
                <span className="rowCopy"><b>{name(l.staffId)}</b><small>{fmtDate(l.date)}{l.note ? ` · ${l.note}` : ''}</small></span>
                <button className="pill" onClick={() => remove(l)}>Remove</button>
              </div>
            ))}
          </div>
          <p className="hint">{counts.map(([n, c]) => `${n}: ${c} ${c === 1 ? 'day' : 'days'}`).join(' · ')}</p>
        </>
      )}

      {sheet && <LeaveSheet shop={shop} person={sheet} date={today} onSaved={reload} onClose={() => setSheet(null)} />}
    </>
  )
}

function LeaveSheet({ shop, person, date: initial, onSaved, onClose }: { shop: Shop; person: StaffMember; date: string; onSaved: () => void; onClose: () => void }) {
  const sheet = useRef<SheetHandle>(null)
  const [date, setDate] = useState(initial)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api(`/shops/${shop.id}/staff/${person.id}/leaves/${date}`, 'PUT', { note: note.trim() })
      onSaved()
      sheet.current?.dismiss()
    } catch (err) {
      setError(errMsg(err))
    }
  }
  return (
    <Sheet ref={sheet} open onClose={onClose} title={`${person.name} · leave`}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Date</span>
          <DateField value={date} onChange={setDate} />
        </label>
        <label className="field">
          <span>Note <small style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</small></span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example, sick or family function" />
        </label>
        {error && <p className="formError">{error}</p>}
        <button className="btn block big">Mark on leave</button>
      </form>
    </Sheet>
  )
}
