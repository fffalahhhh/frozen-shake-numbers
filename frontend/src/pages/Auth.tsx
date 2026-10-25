import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, ApiError, type Shop, type User } from '../api'
import { useSession } from '../session'

function AuthCard({ eyebrow, title, sub, children }: { eyebrow: string; title: string; sub: string; children: ReactNode }) {
  return (
    <div className="authWrap">
      <div className="authCard">
        <img className="logo" src="/icons/icon-192.png" alt="Frozen Shake" />
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
        {children}
      </div>
    </div>
  )
}

/** Shared submit handling: busy state + API error message. */
function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, onSubmit }
}

export function Login() {
  const { signIn } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, onSubmit } = useSubmit(async () => {
    const { user } = await api<{ user: User }>('/auth/login', 'POST', { email, password })
    await signIn(user)
  })
  return (
    <AuthCard eyebrow="Frozen Shake" title="Welcome back" sub="Sign in to your daily cash book.">
      <form onSubmit={onSubmit}>
        <label className="field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="formError">{error}</p>}
        <button className="btn block big" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="alt"><Link to="/forgot-password">Forgot password?</Link></p>
      <p className="alt">New here? <Link to="/register">Create an account</Link></p>
    </AuthCard>
  )
}

export function Register() {
  const { signIn } = useSession()
  const [f, setF] = useState({ name: '', email: '', password: '', shopName: 'Frozen Shake' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const { busy, error, onSubmit } = useSubmit(async () => {
    const { user } = await api<{ user: User }>('/auth/register', 'POST', f)
    await signIn(user)
  })
  return (
    <AuthCard eyebrow="Frozen Shake" title="Create your account" sub="Track revenue, expenses and partner handovers for each shop.">
      <form onSubmit={onSubmit}>
        <label className="field"><span>Your name</span><input autoComplete="name" value={f.name} onChange={set('name')} maxLength={100} /></label>
        <label className="field"><span>Email</span><input type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={f.password} onChange={set('password')} required /><p className="hint">At least 8 characters.</p></label>
        <label className="field"><span>First shop name</span><input value={f.shopName} onChange={set('shopName')} required maxLength={60} /></label>
        {error && <p className="formError">{error}</p>}
        <button className="btn block big" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <p className="alt">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthCard>
  )
}

export function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const { busy, error, onSubmit } = useSubmit(async () => {
    await api('/auth/forgot-password', 'POST', { email })
    setSent(true)
  })
  return (
    <AuthCard eyebrow="Account" title="Reset password" sub="We’ll email you a link to choose a new password.">
      {sent ? (
        <p className="ok">If an account exists for {email}, a reset link is on its way. It expires in 1 hour.</p>
      ) : (
        <form onSubmit={onSubmit}>
          <label className="field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          {error && <p className="formError">{error}</p>}
          <button className="btn block big" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
      <p className="alt"><Link to="/login">Back to sign in</Link></p>
    </AuthCard>
  )
}

export function ResetPassword() {
  const { signIn } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const { busy, error, onSubmit } = useSubmit(async () => {
    if (password !== confirm) throw new ApiError(422, 'validation', 'Passwords don’t match')
    const { user } = await api<{ user: User }>('/auth/reset-password', 'POST', { token: params.get('token') ?? '', password })
    await signIn(user)
    navigate('/', { replace: true })
  })
  return (
    <AuthCard eyebrow="Account" title="Choose a new password" sub="You’ll be signed out on your other devices.">
      <form onSubmit={onSubmit}>
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <label className="field"><span>Repeat password</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
        {error && <p className="formError">{error}</p>}
        <button className="btn block big" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
      <p className="alt"><Link to="/login">Back to sign in</Link></p>
    </AuthCard>
  )
}

/** Shown to a signed-in user who has no shops yet. */
export function CreateFirstShop() {
  const { reloadShops, selectShop, logout } = useSession()
  const [name, setName] = useState('Frozen Shake')
  const { busy, error, onSubmit } = useSubmit(async () => {
    const { shop } = await api<{ shop: Shop }>('/shops', 'POST', { name })
    await reloadShops()
    selectShop(shop.id)
  })
  return (
    <AuthCard eyebrow="Get started" title="Create your shop" sub="Each shop keeps its own revenue, expenses, partners and categories.">
      <form onSubmit={onSubmit}>
        <label className="field"><span>Shop name</span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></label>
        {error && <p className="formError">{error}</p>}
        <button className="btn block big" disabled={busy}>{busy ? 'Creating…' : 'Create shop'}</button>
      </form>
      <p className="alt"><button className="link" onClick={logout}>Sign out</button></p>
    </AuthCard>
  )
}
