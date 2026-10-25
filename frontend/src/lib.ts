// Money and date helpers. Money is handled as integer paise and dates as
// 'YYYY-MM-DD' strings in the shop's timezone: no floats, no UTC drift.

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/

export function isAmount(s: string): boolean {
  return AMOUNT_RE.test(s.trim())
}

/** "1234.5" → 123450. Accepts the decimal strings the API returns (may be negative). */
export function toPaise(s: string | null | undefined): number {
  if (!s) return 0
  const neg = s.startsWith('-')
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.')
  const p = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  return neg ? -p : p
}

/** 123450 → "1234.50" */
export function fromPaise(p: number): string {
  const sign = p < 0 ? '-' : ''
  const abs = Math.abs(p)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 })

/** 245000 → "₹2,450"; 82050 → "₹820.50" */
export function inr(p: number): string {
  return (p % 100 === 0 ? inr0 : inr2).format(p / 100)
}

/** Total of the amounts, in paise. */
export function sum(items: { amount: string }[]): number {
  return items.reduce((t, i) => t + toPaise(i.amount), 0)
}

/** Today's calendar date in the given IANA timezone, e.g. Asia/Kolkata. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function utc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function addDays(date: string, n: number): string {
  const d = utc(date)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** First and last day of the month containing `date`. */
export function monthBounds(date: string): [string, string] {
  const d = utc(date)
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]
}

export function addMonths(date: string, n: number): string {
  const d = utc(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10)
}

/** Formats a calendar date without timezone shifting: "Tue, 13 Oct 2026". */
export function fmtDate(date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }): string {
  return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(utc(date))
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // crypto.randomUUID needs a secure context; plain-http LAN testing doesn't have one.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
