import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { X, type LucideIcon } from 'lucide-react'

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

/** Native <dialog>: focus trapping, Esc to close and backdrop for free. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="sheet"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
    >
      {open && (
        <>
          <div className="sheetHead">
            <h2>{title}</h2>
            <button type="button" className="iconBtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
          <div className="sheetBody">{children}</div>
        </>
      )}
    </dialog>
  )
}

type ConfirmOpts = { title: string; message: string; confirm?: string }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmCtx)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null)
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), [])
  const done = (ok: boolean) => {
    req?.resolve(ok)
    setReq(null)
  }
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Sheet open={!!req} onClose={() => done(false)} title={req?.title ?? ''}>
        <p style={{ margin: '0 0 18px', color: 'var(--muted)' }}>{req?.message}</p>
        <div className="sheetActions">
          <button className="btn ghost" onClick={() => done(false)}>Cancel</button>
          <button className="btn dangerSolid" onClick={() => done(true)} autoFocus>{req?.confirm ?? 'Delete'}</button>
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
