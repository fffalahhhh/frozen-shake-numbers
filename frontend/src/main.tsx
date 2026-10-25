import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { CloudOff } from 'lucide-react'
import '@fontsource-variable/inter'
import './styles.css'
import './pwa'
import { SessionProvider, useSession } from './session'
import { ConfirmProvider } from './ui'
import Layout from './Layout'
import Today from './pages/Today'
import History from './pages/History'
import Day from './pages/Day'
import Partners from './pages/Partners'
import Settings from './pages/Settings'
import { CreateFirstShop, ForgotPassword, Login, Register, ResetPassword } from './pages/Auth'

function App() {
  const { user, shops, ready, bootError, retryBoot } = useSession()
  if (!ready) return <div className="authWrap"><img src="/icons/icon-192.png" alt="Loading Frozen Shake" width={64} height={64} style={{ borderRadius: 19 }} /></div>
  if (bootError && !user) {
    return (
      <div className="authWrap">
        <div className="authCard center">
          <div className="empty">
            <span className="iconTile"><CloudOff size={21} /></span>
            <b>{bootError.status === 0 ? 'You’re offline' : 'Can’t reach Frozen Shake'}</b>
            <small>{bootError.status === 0 ? 'Connect once to sign in. After that, the app works offline on this device.' : bootError.message}</small>
            <button className="btn mt" onClick={retryBoot}>Try again</button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <Routes>
      <Route path="/reset-password" element={<ResetPassword />} />
      {!user ? (
        <>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </>
      ) : shops.length === 0 ? (
        <Route path="*" element={<CreateFirstShop />} />
      ) : (
        <>
          <Route element={<Layout />}>
            <Route index element={<Today />} />
            <Route path="history" element={<History />} />
            <Route path="history/:date" element={<Day />} />
            <Route path="partners" element={<Partners />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
