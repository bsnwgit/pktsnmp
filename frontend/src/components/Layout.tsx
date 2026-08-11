import { ReactNode, useState, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { api } from '../api/client'
import AiAssistant from './AiAssistant'
import { BrandLockup } from './Brand'
import { AutoRefreshProvider, useAutoRefresh } from '../store/autoRefresh'
import clsx from 'clsx'

// ─── Change Password Modal ────────────────────────────────────────────────────
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPw.length < 6) { setError('New password must be at least 6 characters'); return }
    if (newPw !== confirmPw) { setError('Passwords do not match'); return }
    setSaving(true)
    setError('')
    try {
      await api.changeMyPassword(currentPw, newPw)
      setSuccess(true)
      setTimeout(onClose, 1200)
    } catch (e: any) {
      setError(e.message ?? 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="f-panel f-tick-on bg-gray-950 w-full max-w-sm p-7" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-6">
          <h2 className="text-[11px] text-white">Change Password</h2>
          <div className="f-rule" />
        </div>
        {success ? (
          <p className="text-green-400 text-xs text-center py-4 tracking-[0.2em] uppercase">Password updated</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="f-lbl block mb-1.5">Current Password</label>
              <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} required autoFocus
                className="w-full border px-3 py-2" />
            </div>
            <div>
              <label className="f-lbl block mb-1.5">New Password</label>
              <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} required
                className="w-full border px-3 py-2" />
            </div>
            <div>
              <label className="f-lbl block mb-1.5">Confirm New Password</label>
              <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required
                className="w-full border px-3 py-2" />
            </div>
            {error && <p className="text-red-400 text-[10px] tracking-[0.14em] uppercase">{error}</p>}
            <div className="flex justify-end gap-4 pt-2">
              <button type="button" onClick={onClose} className="f-lbl hover:text-white transition-colors">Cancel</button>
              <button type="submit" disabled={saving}
                className="f-lbl f-lbl-gold border border-blue-500/40 px-4 py-2 hover:border-blue-500 hover:text-blue-300 transition-colors disabled:opacity-40">
                {saving ? 'Saving…' : 'Update'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

const NAV = [
  { to: '/',            label: 'Dashboard',  icon: '◑', adminOnly: false },
  { to: '/metrics',     label: 'Metrics',    icon: '∿', adminOnly: false },
  { to: '/devices',     label: 'Devices',    icon: '⬡', adminOnly: false },
  { to: '/alerts',      label: 'Alerts',     icon: '△', adminOnly: false, dividerBefore: true },
  { to: '/logs',        label: 'Logs',       icon: '▤', adminOnly: false },
  { to: '/settings',    label: 'Settings',   icon: '⚙', adminOnly: true, dividerBefore: true },
]

const INTERVALS = [
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m',  value: 60 },
  { label: '5m',  value: 300 },
]

function AutoRefreshControl() {
  const { enabled, intervalSec, setEnabled, setIntervalSec } = useAutoRefresh()
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setEnabled(!enabled)}
        title={enabled ? 'Disable auto-refresh' : 'Enable auto-refresh'}
        className={clsx(
          'flex items-center gap-2 border px-3 py-1.5 f-lbl transition-colors',
          enabled
            ? 'border-blue-500/40 text-blue-400 hover:border-blue-500/70'
            : 'border-gray-700 hover:border-gray-600 hover:text-gray-300',
        )}
      >
        <svg className={clsx('w-2.5 h-2.5', enabled && 'f-spin-slow')}
             style={enabled ? { animationDuration: '8s' } : {}}
             viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        {enabled ? 'Auto' : 'Refresh'}
      </button>
      {enabled && (
        <select
          value={intervalSec}
          onChange={e => setIntervalSec(Number(e.target.value))}
          className="border px-2 py-1.5 text-[10px]"
        >
          {INTERVALS.map(i => (
            <option key={i.value} value={i.value}>{i.label}</option>
          ))}
        </select>
      )}
    </div>
  )
}

// ─── Live clock — the console's sense of "now" ────────────────────────────────
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const p = (n: number) => String(n).padStart(2, '0')
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '−'
  const tz = `UTC${sign}${p(Math.floor(Math.abs(offsetMin) / 60))}`
  return (
    <span className="font-mono text-[11px] text-gray-400 tracking-[0.14em]">
      {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())} {tz}
    </span>
  )
}

export default function Layout({ children, chromeless = false }: { children: ReactNode; chromeless?: boolean }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [unacked, setUnacked] = useState<number>(0)
  const [showChangePw, setShowChangePw] = useState(false)

  // Poll for unresolved+unacked alert count every 30s — skipped entirely
  // when chromeless (embedded, badge is never shown) rather than gated
  // inside the effect, so this hook still runs in a stable order either way.
  useEffect(() => {
    if (chromeless) return
    const tick = async () => {
      try {
        const events = await api.getAlertEvents({ active: true, acked: false, limit: 500 })
        setUnacked(events.length)
      } catch {
        // silently ignore — badge just won't show if API is down
      }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  // Chromeless: embedded via pkthub's remote-settings iframe — no sidebar,
  // no header, just the page content. Still wrapped in AutoRefreshProvider
  // since Settings.tsx (and others) call useAutoRefresh().
  if (chromeless) {
    return (
      <AutoRefreshProvider>
        <div className="relative z-10 text-white min-h-screen p-6">
          {children}
        </div>
      </AutoRefreshProvider>
    )
  }

  return (
    <AutoRefreshProvider>
    <div className="relative z-10 flex h-screen text-white overflow-hidden">

      {/* ── rail ───────────────────────────────────────────────────────── */}
      <aside
        className="w-[210px] flex-shrink-0 flex flex-col py-5 border-r border-blue-500/25"
        style={{ background: 'linear-gradient(180deg, rgba(216,180,110,.02), transparent 40%)' }}
      >
        <div className="px-5 pb-5">
          <BrandLockup markSize={30} />
        </div>
        <div className="h-px bg-blue-500/25 mx-5" />

        <nav className="flex-1 px-3 py-4 flex flex-col gap-px">
          {NAV.filter(n => !n.adminOnly || user?.role === 'admin').map(({ to, label, icon, dividerBefore }) => (
            <div key={to}>
              {dividerBefore && <div className="h-px bg-blue-500/25 mx-3 my-3" />}
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) => clsx(
                  'group relative flex items-center gap-3 pl-4 pr-3 py-2.5 text-[11.5px] uppercase transition-colors',
                  isActive
                    ? 'text-blue-300 bg-gradient-to-r from-blue-500/10 to-transparent'
                    : 'text-gray-400 hover:text-white hover:bg-blue-500/[0.035]',
                )}
                style={{ letterSpacing: '0.13em' }}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-blue-500"
                        style={{ boxShadow: '0 0 10px rgba(216,180,110,.75)' }}
                      />
                    )}
                    <span className={clsx(
                      'text-xs w-3.5 text-center leading-none transition-colors',
                      isActive ? 'text-blue-500' : 'text-gray-500 group-hover:text-blue-500',
                    )}>{icon}</span>
                    <span>{label}</span>
                    {label === 'Alerts' && unacked > 0 && (
                      <span className="ml-auto font-mono text-[9.5px] text-red-500 border border-red-500/40 px-1.5 leading-relaxed">
                        {unacked}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </div>
          ))}
        </nav>

        <div className="px-3">
          <NavLink
            to="/documentation"
            className={({ isActive }) => clsx(
              'group relative flex items-center gap-3 pl-4 pr-3 py-2.5 text-[11.5px] uppercase transition-colors',
              isActive
                ? 'text-blue-300 bg-gradient-to-r from-blue-500/10 to-transparent'
                : 'text-gray-400 hover:text-white hover:bg-blue-500/[0.035]',
            )}
            style={{ letterSpacing: '0.13em' }}
          >
            <span className="text-xs w-3.5 text-center leading-none text-gray-500 group-hover:text-blue-500">❐</span>
            <span>Docs</span>
          </NavLink>
        </div>

        {/* operator */}
        <div className="mx-3 mt-3 pt-4 px-3 border-t border-blue-500/25 flex items-center gap-3">
          <div
            className="w-7 h-7 flex-none grid place-items-center rounded-full border border-blue-500/40 font-mono text-[11px] text-blue-300"
            style={{ boxShadow: 'inset 0 0 14px rgba(216,180,110,.14)' }}
          >
            {user?.username?.[0]?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-white truncate tracking-[0.1em]">{user?.username}</p>
            <p className="f-lbl mt-0.5">{user?.role}</p>
          </div>
          {user?.authProvider === 'local' && (
            <button onClick={() => setShowChangePw(true)} title="Change password"
                    className="text-gray-500 hover:text-blue-400 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/>
              </svg>
            </button>
          )}
          <button onClick={handleLogout} title="Sign out"
                  className="text-gray-500 hover:text-red-500 transition-colors">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </aside>

      {/* ── centre ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-12 flex-shrink-0 border-b border-blue-500/25 flex items-center px-6 gap-5">
          <div className="flex items-center gap-2.5">
            <span
              className="w-1.5 h-1.5 rounded-full bg-green-400 f-breathe"
              style={{ boxShadow: '0 0 9px #7ee0a8' }}
            />
            <span className="f-lbl">SNMP Monitor · Nominal</span>
          </div>
          <div className="ml-auto flex items-center gap-5">
            <Clock />
            <AutoRefreshControl />
          </div>
        </header>

        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>

      <AiAssistant />
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
    </AutoRefreshProvider>
  )
}
