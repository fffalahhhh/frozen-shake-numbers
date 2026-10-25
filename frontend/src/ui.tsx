import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type PointerEvent, type ReactNode, type Ref } from 'react'
import { CalendarDays, X, type LucideIcon } from 'lucide-react'
import { fmtDate } from './lib'

export function PageHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <header className="pageHead">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{sub}</p>
    </header>
  )
}

export function Empty({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="empty">
      <span className="iconTile"><Icon size={21} strokeWidth={1.8} /></span>
      <b>{title}</b>
      <small>{text}</small>
    </div>
  )
}

export function Skeleton({ rows = 2 }: { rows?: number }) {
  return <div style={{ display: 'grid', gap: 10 }}>{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>
}

export function Status({ item }: { item: { pending?: boolean; failed?: boolean } }) {
  if (item.failed) return <span className="chip danger">Not saved</span>
  if (item.pending) return <span className="chip">Pending sync</span>
  return null
}

export type SheetHandle = { dismiss: () => void }
const EXIT_MS = 220 // matches the .closing animation in styles.css

/**
 * iOS-style sheet on a native <dialog> (focus trap, Esc, top layer for free):
 * springs up, swipe the handle down to dismiss, animates out.
 * Call ref.dismiss() to close with the animation; onClose fires after it.
 */
export function Sheet({ open, onClose, title, children, ref, variant }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; ref?: Ref<SheetHandle>; variant?: 'actionSheet'
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const drag = useRef<{ y: number; t: number } | null>(null)
  const [dy, setDy] = useState(0)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const d = dialog.current!
    if (open && !d.open) {
      setClosing(false)
      setDy(0)
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])

  const dismiss = useCallback(() => {
    setClosing(true)
    setTimeout(onClose, EXIT_MS)
  }, [onClose])
  useImperativeHandle(ref, () => ({ dismiss }), [dismiss])

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return
    drag.current = { y: e.clientY, t: Date.now() }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => drag.current && setDy(Math.max(0, e.clientY - drag.current.y))
  const up = () => {
    if (!drag.current) return
    const velocity = dy / Math.max(1, Date.now() - drag.current.t)
    drag.current = null
    if (dy > 110 || velocity > 0.5) dismiss()
    else setDy(0)
  }

  return (
    <dialog
      ref={dialog}
      className={['sheet', variant, closing && 'closing'].filter(Boolean).join(' ')}
      onCancel={(e) => { e.preventDefault(); dismiss() }}
      onClick={(e) => e.target === dialog.current && dismiss()}
      aria-label={title}
      style={dy ? { transform: `translateY(${dy}px)`, transition: drag.current ? 'none' : undefined } : undefined}
    >
      {open && (variant === 'actionSheet' ? children : (
        <>
          <div className="sheetDrag" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <span className="grabber" />
            <div className="sheetHead">
              <h2>{title}</h2>
              <button type="button" className="closeBtn" onClick={dismiss} aria-label="Close"><X size={16} strokeWidth={2.5} /></button>
            </div>
          </div>
          <div className="sheetBody">{children}</div>
        </>
      ))}
    </dialog>
  )
}

type ConfirmOpts = { title: string; message: string; confirm?: string }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmCtx)

/** Destructive confirmations as an iOS action sheet. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null)
  const sheet = useRef<SheetHandle>(null)
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), [])
  const answer = (ok: boolean) => {
    req?.resolve(ok)
    sheet.current?.dismiss()
  }
  const closed = useCallback(() => setReq((r) => (r?.resolve(false), null)), [])
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Sheet ref={sheet} open={!!req} onClose={closed} title={req?.title ?? ''} variant="actionSheet">
        <div className="actionGroup">
          <p className="actionMsg"><b>{req?.title}</b>{req?.message}</p>
          <button className="actionBtn danger" onClick={() => answer(true)}>{req?.confirm ?? 'Delete'}</button>
        </div>
        <div className="actionGroup">
          <button className="actionBtn cancel" onClick={() => answer(false)} autoFocus>Cancel</button>
        </div>
      </Sheet>
    </ConfirmCtx.Provider>
  )
}

export function MoneyInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div className="money">
      <input
        inputMode="decimal"
        placeholder="0"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        aria-label="Amount in rupees"
        required
      />
    </div>
  )
}

/** Opens the platform's native date picker in a field that looks the same everywhere. */
export function openPicker(e: { currentTarget: HTMLInputElement }) {
  try {
    e.currentTarget.showPicker()
  } catch {
    // already open, or unsupported: tapping the input still works
  }
}

export function DateField({ value, onChange, min, max, label = 'Date' }: { value: string; onChange: (d: string) => void; min?: string; max?: string; label?: string }) {
  return (
    <span className="dateField">
      <CalendarDays size={18} strokeWidth={1.8} />
      <span>{value ? fmtDate(value) : 'Choose a date'}</span>
      <input type="date" value={value} min={min} max={max} aria-label={label} onClick={openPicker}
        onChange={(e) => e.target.value && onChange(e.target.value)} />
    </span>
  )
}
