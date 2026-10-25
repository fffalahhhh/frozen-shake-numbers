import { useState } from 'react'
import { Forward, Users } from 'lucide-react'
import { useFetch, type Handover, type Partner, type Shop } from '../api'
import { useSession } from '../session'
import { applyOps, overlayOps, useSync } from '../sync'
import { addDays, fmtDate, inr, monthBounds, newestFirst, toPaise, todayIn } from '../lib'
import { DateField, Empty, PageHead, Skeleton, Status } from '../ui'
import { TxnSheet } from '../sheets'

type Preset = 'all' | 'month' | '30d' | 'custom'

export default function Partners() {
  const shop = useSession().shop as Shop
  const today = todayIn(shop.timezone)
  const [preset, setPreset] = useState<Preset>('all')
  const [range, setRange] = useState({ from: monthBounds(today)[0], to: today })
  const [selected, setSelected] = useState<string | null>(null)
  const [sheet, setSheet] = useState<{ item?: Handover } | null>(null)
  useSync()

  const [from, to] = preset === 'all' ? ['', ''] : preset === 'month' ? [monthBounds(today)[0], today] : preset === '30d' ? [addDays(today, -29), today] : [range.from, range.to]
  const q = new URLSearchParams({ ...(from && { from }), ...(to && { to }) })
  const base = `/shops/${shop.id}`
  const parts = useFetch<{ partners: Partner[] }>(`${base}/partners?${q}`)
  const listQ = new URLSearchParams(q)
  listQ.set('limit', '100')
  if (selected) listQ.set('partnerId', selected)
  const ho = useFetch<{ items: Handover[] }>(`${base}/handovers?${listQ}`)

  const partners = (parts.data?.partners ?? []).filter((p) => p.active || p.handoverCount > 0)
  const handovers = applyOps(ho.data?.items ?? [], overlayOps(shop.id, 'handover', ho.loadedAt),
    (h) => (!from || h.date >= from) && (!to || h.date <= to) && (!selected || h.partnerId === selected))
    .sort(newestFirst)
  const selectedName = partners.find((p) => p.id === selected)?.name

  return (
    <>
      <PageHead eyebrow="Cash given to owners" title="Partners" sub="Keep a clear record of money handed to each owner." />

      <button className="btn block big" onClick={() => setSheet({})}><Forward size={19} /> Record cash handover</button>

      <div className="sectionHead"><h2>Total handed over</h2></div>
      <div className="seg">
        {([['all', 'All time'], ['month', 'This month'], ['30d', 'Last 30 days'], ['custom', 'Custom']] as const).map(([k, label]) => (
          <button key={k} className={preset === k ? 'on' : ''} onClick={() => setPreset(k)}>{label}</button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="rangeRow">
          <label className="field"><span>From</span><DateField value={range.from} max={range.to} onChange={(d) => setRange({ ...range, from: d })} label="From" /></label>
          <label className="field"><span>To</span><DateField value={range.to} min={range.from} max={today} onChange={(d) => setRange({ ...range, to: d })} label="To" /></label>
        </div>
      )}

      {parts.loading && !parts.data ? <Skeleton rows={2} /> : parts.error && !parts.data ? (
        <div className="banner danger"><span className="grow">{parts.error.status === 0 ? 'You’re offline and partner totals aren’t saved on this device yet.' : parts.error.message}</span><button className="pill" onClick={parts.reload}>Retry</button></div>
      ) : (
        <div className="partnerGrid">
          {partners.map((p) => (
            <button key={p.id} className={'partner' + (selected === p.id ? ' selected' : '')} onClick={() => setSelected(selected === p.id ? null : p.id)} aria-pressed={selected === p.id}>
              <span className="avatar">{p.name.charAt(0).toUpperCase()}</span>
              <b>{p.name}</b>
              <strong>{inr(toPaise(p.totalHandedOver))}</strong>
              <small>{p.active ? `${p.handoverCount} handover${p.handoverCount === 1 ? '' : 's'}` : 'Inactive'}</small>
            </button>
          ))}
        </div>
      )}

      <div className="sectionHead">
        <h2>{selectedName ? `Handovers to ${selectedName}` : 'Recent handovers'}</h2><span className="count">{handovers.length}</span>
        {selected && <button className="link" onClick={() => setSelected(null)}>Show all</button>}
      </div>
      {ho.loading && !ho.data ? <Skeleton /> : handovers.length === 0 ? (
        <Empty icon={Users} title="No handovers recorded" text="When you give cash to a partner, record their name and amount here." />
      ) : (
        <div className="list">
          {handovers.map((h) => (
            <button className="row" key={h.id} onClick={() => setSheet({ item: h })}>
              <span className="iconTile warm"><Forward size={19} strokeWidth={1.7} /></span>
              <span className="rowCopy">
                <b>{h.partnerName}<Status item={h} /></b>
                <small>{fmtDate(h.date)}{h.note ? ` · ${h.note}` : ''}</small>
              </span>
              <span className="amount">{inr(toPaise(h.amount))}</span>
            </button>
          ))}
        </div>
      )}

      {sheet && (
        <TxnSheet kind="handover" shop={shop} date={today} item={sheet.item} options={parts.data?.partners ?? []} onClose={() => setSheet(null)} />
      )}
    </>
  )
}
