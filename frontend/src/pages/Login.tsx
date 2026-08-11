import { useState, useEffect, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { BrandLockup } from '../components/Brand'

const SSO_ERROR_MESSAGES: Record<string, string> = {
  missing_params:             'SSO login failed: missing code or state.',
  invalid_state:              'SSO login failed: invalid state (possible CSRF). Please try again.',
  user_inactive:              'Your account is inactive. Contact an administrator.',
  saml_disabled:              'SAML SSO is not currently enabled.',
  saml_processing_failed:     'SAML response could not be processed. Check your IdP configuration.',
  saml_invalid_response:      'SAML response validation failed. Check IdP certificate and entity IDs.',
  not_authenticated:          'SAML authentication was not confirmed by the IdP.',
}

export default function Login() {
  const { login, user } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [username, setUsername]   = useState('')
  const [password, setPassword]   = useState('')
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [samlEnabled, setSamlEnabled]   = useState(false)
  const [localEnabled, setLocalEnabled] = useState(true)
  const [samlLoading, setSamlLoading]   = useState(false)

  // If auto-login (all auth methods disabled) already established a session
  // in the background, leave immediately instead of showing a login form.
  useEffect(() => {
    if (user) navigate('/', { replace: true })
  }, [user])

  // Check SSO error from redirect and fetch auth config
  useEffect(() => {
    const ssoError = searchParams.get('sso_error')
    if (ssoError) {
      setError(SSO_ERROR_MESSAGES[ssoError] ?? `SSO error: ${ssoError}`)
    }

    fetch('/api/auth/config')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        if (data.saml_enabled) setSamlEnabled(true)
        setLocalEnabled(data.local_enabled !== false)
      })
      .catch(() => {})
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
      navigate('/')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const handleSamlLogin = () => {
    setSamlLoading(true)
    window.location.href = '/api/auth/saml/login'
  }

  return (
    <div className="relative z-10 min-h-screen flex items-center justify-center overflow-hidden">

      {/* Decorative survey rings behind the panel — the console "waking up" */}
      <svg
        className="absolute pointer-events-none opacity-[0.55]"
        width="720" height="720" viewBox="0 0 720 720" fill="none"
        aria-hidden="true"
      >
        <g className="f-spin-slow">
          <circle cx="360" cy="360" r="330" stroke="rgba(216,180,110,.07)" />
          <circle cx="360" cy="360" r="330" stroke="rgba(216,180,110,.22)" strokeDasharray="2 26" />
          <circle cx="360" cy="30" r="3" fill="rgba(216,180,110,.5)" />
        </g>
        <g className="f-spin-rev">
          <circle cx="360" cy="360" r="252" stroke="rgba(126,207,226,.09)" />
          <circle cx="360" cy="360" r="252" stroke="rgba(126,207,226,.2)" strokeDasharray="60 420" strokeLinecap="round" />
        </g>
        <circle cx="360" cy="360" r="186" stroke="rgba(216,180,110,.05)" />
      </svg>

      <div className="relative w-full max-w-[380px] px-6">
        {/* Mark */}
        <div className="flex justify-center mb-9">
          <BrandLockup markSize={54} descriptor="SNMP Telemetry Console" />
        </div>

        <div className="f-panel f-tick-on bg-gray-950/80 backdrop-blur-sm p-8 space-y-6">

          <div className="flex items-center gap-3">
            <span className="f-lbl f-lbl-gold">Authenticate</span>
            <div className="f-rule" />
          </div>

          {/* SAML SSO button — shown when configured */}
          {samlEnabled && (
            <>
              <button
                type="button"
                onClick={handleSamlLogin}
                disabled={samlLoading}
                className="w-full flex items-center justify-center gap-3 border border-blue-500/40 hover:border-blue-500 hover:bg-blue-500/[0.06] disabled:opacity-40 disabled:cursor-not-allowed text-blue-300 py-3 transition-colors f-lbl"
              >
                <svg viewBox="0 0 28 28" className="w-4 h-4 flex-shrink-0" fill="none">
                  <circle cx="14" cy="14" r="12" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="14" cy="14" r="5" fill="currentColor"/>
                </svg>
                {samlLoading ? 'Redirecting…' : 'Sign in with Okta'}
              </button>

              {localEnabled && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-blue-500/[0.12]" />
                  <span className="f-lbl">or</span>
                  <div className="flex-1 h-px bg-blue-500/[0.12]" />
                </div>
              )}
            </>
          )}

          {/* Local login form — hidden when local auth is disabled */}
          {localEnabled && <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="f-lbl block mb-2">Username or Email</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}
                required
                autoFocus
                className="w-full border px-3 py-2.5"
                placeholder="admin"
              />
            </div>
            <div>
              <label className="f-lbl block mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}
                required
                className="w-full border px-3 py-2.5"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="border border-red-500/40 bg-red-500/[0.06] px-3 py-2.5 text-red-400 text-[10px] uppercase tracking-[0.14em] leading-relaxed">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full border border-blue-500/40 hover:border-blue-500 hover:bg-blue-500/25 hover:text-blue-200 disabled:opacity-40 disabled:cursor-not-allowed text-blue-300 py-3 transition-colors f-lbl"
            >
              {loading ? 'Authenticating…' : 'Sign in'}
            </button>
          </form>}
        </div>

        <p className="f-lbl text-center mt-6" style={{ letterSpacing: '0.34em' }}>
          Packet Software Netware
        </p>
      </div>
    </div>
  )
}
