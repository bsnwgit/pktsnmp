import { Component, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, getToken, User, UserIn, SslStatus, HierarchyOrg, HierarchyGroup, HierarchySite, HierarchyLocation, UserApiKey, Integration, IntegrationInput } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'
import { copyToClipboard } from '../utils/clipboard'
import Collectors from './Collectors'
import OidCatalog from './OidCatalog'
import { BrandLockup } from '../components/Brand'

// ── Error boundary ────────────────────────────────────────────────────────────
class TabErrorBoundary extends Component<{ children: React.ReactNode }, { err: Error | null }> {
  constructor(props: { children: React.ReactNode }) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (this.state.err) return (
      <div className="bg-red-900/20 border border-red-700/50 rounded-xl p-6 space-y-2">
        <p className="text-red-400 text-sm font-semibold">Something went wrong loading this tab</p>
        <p className="text-xs text-red-600 font-mono">{this.state.err.message}</p>
        <button onClick={() => this.setState({ err: null })}
          className="text-xs text-gray-400 hover:text-white mt-2">Retry</button>
      </div>
    )
    return this.props.children
  }
}

// ── Generic helpers ────────────────────────────────────────────────────────────
type Settings = Record<string, unknown>

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800 last:border-0">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {hint && <p className="text-xs text-white mt-0.5">{hint}</p>}
      </div>
      <div className="col-span-2">{children}</div>
    </div>
  )
}

function TextInput({ value, onChange, placeholder = '', secret = false, mono = false }: {
  value: string; onChange: (v: string) => void
  placeholder?: string; secret?: boolean; mono?: boolean
}) {
  return (
    <input
      type={secret ? 'password' : 'text'}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${mono ? 'font-mono' : ''}`}
    />
  )
}

function NumberInput({ value, onChange, min, max }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number
}) {
  return (
    <input
      type="number" min={min} max={max}
      value={value}
      onChange={e => onChange(parseInt(e.target.value) || 0)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-gray-700'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function RestartServiceRow() {
  const [state, setState] = useState<'idle' | 'restarting' | 'done' | 'error'>('idle')

  const restart = async () => {
    if (state === 'restarting') return
    setState('restarting')
    try {
      await api.restartService()
      setState('done')
      setTimeout(() => setState('idle'), 8000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 4000)
    }
  }

  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800">
      <div>
        <p className="text-sm font-medium text-white">Restart Service</p>
        <p className="text-xs text-white mt-0.5">Apply backend changes or recover from errors</p>
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <button
          onClick={restart}
          disabled={state === 'restarting'}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-white text-white text-sm font-medium rounded-lg transition-colors"
        >
          {state === 'restarting' ? 'Restarting…' : 'Restart Service'}
        </button>
        {state === 'done' && (
          <span className="text-sm text-amber-400">Service is restarting — reload the page in ~5 seconds</span>
        )}
        {state === 'error' && (
          <span className="text-sm text-red-400">Restart failed — check server logs</span>
        )}
      </div>
    </div>
  )
}

// ── Snapshot files vary per backup (ClickHouse export can fail/be disabled),
// so the checkbox set is derived from what's actually in that snapshot ──
function SnapshotRestoreRow({ snapshot, onRestored }: {
  snapshot: { name: string; path: string; size_bytes: number; files: string[] }
  onRestored: (name: string, result: Record<string, string>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set(snapshot.files))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (f: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f); else next.add(f)
      return next
    })
  }

  const restore = async () => {
    if (selected.size === 0) return
    const which = selected.size === snapshot.files.length ? 'all files' : Array.from(selected).join(', ')
    if (!window.confirm(`Restore ${which} from ${snapshot.name}?\n\nThis overwrites current data and cannot be undone.`)) return
    setRunning(true)
    setError(null)
    try {
      const result = await api.restoreSnapshot(snapshot.name, Array.from(selected))
      onRestored(snapshot.name, result)
      setExpanded(false)
    } catch (e: any) {
      setError(e.message || 'Restore failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="text-xs text-white">
      <div className="flex items-center gap-3">
        <span className="font-mono">{snapshot.name}</span>
        <span className="text-white">{(snapshot.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
        <span className="text-white">{snapshot.files.join(', ')}</span>
        <button onClick={() => setExpanded(v => !v)} className="text-blue-400 hover:text-blue-300 underline">
          {expanded ? 'Cancel' : 'Restore…'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 mb-3 ml-4 space-y-2 bg-gray-800/60 rounded-lg p-3">
          <p className="text-white">Choose which files to restore:</p>
          <div className="flex flex-wrap gap-4">
            {snapshot.files.map(f => (
              <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={selected.has(f)} onChange={() => toggle(f)} className="accent-amber-600" />
                <span className="font-mono">{f}</span>
              </label>
            ))}
          </div>
          <button onClick={restore} disabled={running || selected.size === 0}
            className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs rounded-lg px-3 py-1.5 transition-colors">
            {running ? 'Restoring…' : 'Restore Selected'}
          </button>
          {error && <p className="text-red-400 mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}

// ── Port field — lives in config.yaml, not the SQLite-backed settings; value
// is lifted to the parent so it saves through the General tab's one Save button ──
function PortField({ value, onChange, loaded }: { value: number; onChange: (v: number) => void; loaded: boolean }) {
  return (
    <Field label="Port" hint="Port the app listens on. Requires a service restart — the browser will need to follow the app to the new port/URL afterward.">
      {!loaded ? (
        <p className="text-xs text-white">Loading…</p>
      ) : (
        <NumberInput value={value} onChange={onChange} min={1} max={65535} />
      )}
    </Field>
  )
}

// ── Section wrapper with Save ─────────────────────────────────────────────────

// ── Log forwarding tester ─────────────────────────────────────────────────────
// A forwarder that silently drops everything looks identical to one that works,
// so the settings page has to be able to prove the path end to end.
function LogForwardTester({ host, port, protocol }: { host: string; port: number; protocol: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')
  const [ok, setOk] = useState<boolean | null>(null)

  const run = async () => {
    setBusy(true); setResult(''); setOk(null)
    try {
      const r = await api.logForwardTest(host, port, protocol)
      setOk(r.ok)
      setResult(r.ok
        ? `Sent 1 message to ${r.target} — check pktLog for "pktSNMP log forwarding test message"`
        : `Failed: ${r.last_error || 'no bytes sent'}`)
    } catch (e: any) {
      setOk(false); setResult(e.message || 'Test failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field label="Test" hint="Sends one message using the values above, without saving them">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={run}
          disabled={busy || !host}
          className="f-lbl f-lbl-gold border border-blue-500/40 px-4 py-2 hover:border-blue-500 hover:text-blue-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Sending…' : 'Send test message'}
        </button>
        {result && (
          <span className={`text-xs ${ok ? 'text-green-400' : 'text-red-400'}`}>{result}</span>
        )}
        {!host && <span className="text-xs text-gray-500">Set a collector host first</span>}
      </div>
    </Field>
  )
}

function Section({
  title, help, children, onSave, saving, saved, error,
}: {
  title: string
  help?: { title: string; content: React.ReactNode }
  children: React.ReactNode
  onSave: () => Promise<void>
  saving: boolean
  saved: boolean
  error: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {help && <HelpButton title={help.title}>{help.content}</HelpButton>}
      </div>
      <div className="px-6 py-2">
        {children}
      </div>
      <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  )
}

// ── Resonance origin ──────────────────────────────────────────────────────────
// The one string that has to be copied onto the resonance key, so it is edited
// and copied in the same place. Showing it twice — once editable in the form and
// once read-only beside a Copy button — reliably sends people to the copy.
function ResonanceOriginField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [detected, setDetected] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { api.resonanceStatus().then(r => setDetected(r.detected_origin || '')).catch(() => {}) }, [])

  const effective = value.trim() || detected

  return (
    <div>
      <div className="flex items-center gap-2">
        <TextInput value={value} onChange={onChange} placeholder={detected || 'https://pktsnmp.example.com'} mono />
        <button
          type="button"
          onClick={() => { navigator.clipboard?.writeText(effective); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap px-2"
        >{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {!value.trim() && detected && (
        <p className="text-xs text-gray-500 mt-1">
          Blank — using <span className="font-mono">{detected}</span>.
        </p>
      )}
    </div>
  )
}

// ── Resonance diagnostics ─────────────────────────────────────────────────────
// Everything here answers a question an admin would otherwise have to open the
// resonance console to answer: what does this key actually allow, is this
// install's origin the one the key expects, and is the widget reaching anyone.
function ResonanceDiagnostics({ baseUrl, keyValue }: { baseUrl: string; keyValue: string }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.resonanceTest>> | null>(null)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.resonanceStatus>> | null>(null)

  const loadStatus = () => { api.resonanceStatus().then(setStatus).catch(() => {}) }
  useEffect(loadStatus, [])

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api.resonanceTest(baseUrl, keyValue))
    } catch (e: any) {
      setResult({ ok: false, error: e.message || 'Test failed', origin: '' })
    } finally {
      setTesting(false)
      loadStatus()
    }
  }

  const cap = (result?.cap || {}) as Record<string, unknown>
  const failures = status?.load_failures

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mt-5">
      <div className="px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">Diagnostics</h2>
      </div>
      <div className="px-6 py-4 space-y-4">

        {/* getUserMedia is gated on a secure context, so the microphone cannot
            work over plain HTTP however the key is configured. */}
        {!window.isSecureContext && (
          <p className="text-xs text-amber-400">
            Served over HTTP — voice is unavailable. Text chat is unaffected.
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >{testing ? 'Testing…' : 'Test Connection'}</button>
          <span className="text-xs text-white">Works whether or not the widget is enabled.</span>
        </div>

        {result && !result.ok && (
          <div className="text-xs">
            <p className="text-red-400">{result.error}</p>
            {result.detail && <p className="text-gray-500 mt-0.5 font-mono">{result.detail}</p>}
          </div>
        )}

        {result?.ok && (
          <div className="text-xs text-white space-y-1">
            <p className="text-green-400">Connected — this key grants:</p>
            <p>
              ask {cap.ask ? '✓' : '✗'} &middot; mic {cap.mic ? '✓' : '✗'} &middot; speak {cap.speak ? '✓' : '✗'}
            </p>
            <p>
              Limits: {String(cap.rate_per_min ?? '?')}/min per key, {String(cap.rate_per_visitor ?? '?')}/min per person
            </p>
            <p>
              Session: {result.expires_in ? Math.round(result.expires_in / 60) : '?'} min &middot; Code: {result.code_expires_in ?? '?'}s
            </p>
            <p className="text-gray-500">Sent as {result.user_id_sent}</p>
          </div>
        )}

        {status?.breaker.open && (
          <p className="text-xs text-amber-400">
            Paused after {status.breaker.failures} failures — retrying in {status.breaker.retry_in_seconds}s.
            {status.breaker.last_error ? ` Last error: ${status.breaker.last_error}` : ''}
          </p>
        )}

        {failures && failures.events > 0 && (
          <p className="text-xs text-amber-400">
            The widget failed to load for {failures.users} user{failures.users === 1 ? '' : 's'}
            {' '}({failures.events} time{failures.events === 1 ? '' : 's'}) in the last {failures.days} days.
            Common causes are an ad blocker, a wrong server address, or resonance being unreachable.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Per-tab save state ────────────────────────────────────────────────────────
interface SaveState { saving: boolean; saved: boolean; error: string }
const INIT: SaveState = { saving: false, saved: false, error: '' }

function SendTestButton({ channel }: { channel: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'sent' | 'failed' | 'skipped'>('idle')
  const [detail, setDetail] = useState('')

  const run = async () => {
    setStatus('loading')
    setDetail('')
    try {
      const res = await api.testNotification(channel)
      setStatus(res.status as 'sent' | 'failed' | 'skipped')
      setDetail(res.detail || '')
    } catch (e) {
      setStatus('failed')
      setDetail(String(e))
    }
  }

  return (
    <div className="flex items-center gap-3 mt-2 mb-1">
      <button
        onClick={run}
        disabled={status === 'loading'}
        className="px-3 py-1.5 text-xs rounded-lg border border-gray-600 bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {status === 'loading' ? 'Sending…' : 'Send Test'}
      </button>
      {status === 'sent'    && <span className="text-xs text-green-400">✓ Sent{detail ? ` — ${detail}` : ''}</span>}
      {status === 'skipped' && <span className="text-xs text-yellow-400">⚠ Skipped — {detail}</span>}
      {status === 'failed'  && <span className="text-xs text-red-400">✗ Failed — {detail}</span>}
    </div>
  )
}

function useSave(keys: string[], settings: Settings, onSuccess: () => void) {
  const [state, setState] = useState<SaveState>(INIT)

  const save = async () => {
    setState({ saving: true, saved: false, error: '' })
    try {
      const subset: Settings = {}
      for (const k of keys) if (k in settings) subset[k] = settings[k]
      await api.bulkUpdateSettings(subset)
      setState({ saving: false, saved: true, error: '' })
      onSuccess()
      setTimeout(() => setState(s => ({ ...s, saved: false })), 3000)
    } catch (e: any) {
      setState({ saving: false, saved: false, error: e.message || 'Save failed' })
    }
  }

  return { ...state, save }
}

// ── Drag-and-drop cert/key textarea ──────────────────────────────────────────
function CertTextarea({ value, onChange, rows = 4, placeholder = 'MIIDp…', secret = false }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; secret?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const stripPem = (raw: string) =>
    raw
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/\s+/g, '')

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      onChange(stripPem(text))
      setRevealed(false)
    }
    reader.readAsText(file)
  }

  if (secret && value && !revealed) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-green-400 font-mono">
          ✓ Certificate saved
        </div>
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap px-2 py-1 border border-gray-700 rounded-lg bg-gray-800"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-xs text-red-400 hover:text-red-300 whitespace-nowrap px-2 py-1 border border-gray-700 rounded-lg bg-gray-800"
        >
          Clear
        </button>
      </div>
    )
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative rounded-lg transition-colors ${dragging ? 'ring-2 ring-blue-400 bg-blue-950/30' : ''}`}
    >
      {secret && revealed && (
        <div className="flex justify-end mb-1">
          <button type="button" onClick={() => setRevealed(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
        </div>
      )}
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
      />
      {dragging && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg pointer-events-none">
          <p className="text-blue-300 text-sm font-medium bg-gray-900/80 px-3 py-1 rounded">Drop to import</p>
        </div>
      )}
      <p className="text-xs text-gray-600 mt-1">Paste content or drag &amp; drop a .pem / .crt / .cer file</p>
    </div>
  )
}

// ── SAML metadata paste box ───────────────────────────────────────────────────
function MetadataPasteBox({ onParsed }: {
  onParsed: (r: { entity_id: string; sso_url: string; cert: string }) => void
}) {
  const [xml, setXml]       = useState('')
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [msg, setMsg]       = useState('')

  const handleChange = (raw: string) => {
    setXml(raw)
    if (!raw.trim()) { setStatus('idle'); setMsg(''); return }
    const result = parseIdpMetadata(raw)
    if (result.error) {
      setStatus('error')
      setMsg(result.error)
    } else {
      onParsed(result)
      setStatus('ok')
      setMsg('Entity ID, SSO URL, and certificate populated below.')
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={xml}
        onChange={e => handleChange(e.target.value)}
        rows={5}
        placeholder={'<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" …>'}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
      />
      {status === 'ok'    && <p className="text-xs text-emerald-400">✓ {msg}</p>}
      {status === 'error' && <p className="text-xs text-red-400">✗ {msg}</p>}
    </div>
  )
}

// ── SAML IdP metadata parser ──────────────────────────────────────────────────
function parseIdpMetadata(xml: string): {
  entity_id: string; sso_url: string; cert: string; error?: string
} {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return { entity_id: '', sso_url: '', cert: '', error: 'Invalid XML — check the metadata and try again.' }

    const root = doc.querySelector('EntityDescriptor') ?? doc.documentElement
    const entity_id = root.getAttribute('entityID') ?? ''

    let sso_url = ''
    const ssoNodes = Array.from(doc.querySelectorAll('SingleSignOnService'))
    const redirect = ssoNodes.find(n => (n.getAttribute('Binding') ?? '').includes('HTTP-Redirect'))
    sso_url = (redirect ?? ssoNodes[0])?.getAttribute('Location') ?? ''

    let cert = ''
    const keyDescs = Array.from(doc.querySelectorAll('KeyDescriptor'))
    const signingKd = keyDescs.find(kd => !kd.getAttribute('use') || kd.getAttribute('use') === 'signing')
    const x509El = signingKd?.querySelector('X509Certificate') ?? doc.querySelector('X509Certificate')
    cert = x509El?.textContent?.replace(/\s+/g, '') ?? ''

    if (!entity_id && !sso_url && !cert)
      return { entity_id: '', sso_url: '', cert: '', error: 'No SAML IdP data found in this XML.' }

    return { entity_id, sso_url, cert }
  } catch {
    return { entity_id: '', sso_url: '', cert: '', error: 'Failed to parse XML.' }
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────
type TabId = 'general' | 'security' | 'data' | 'snmp' | 'notifications' | 'resonance' | 'apikeys' | 'system' | 'collectors' | 'oidcatalog' | 'hierarchy'

const TABS: Array<{ id: TabId; label: string; adminOnly?: boolean; gapBefore?: boolean }> = [
  { id: 'general',       label: 'General' },
  { id: 'security',      label: 'Security' },
  { id: 'data',          label: 'Data' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'resonance',     label: 'Resonance', adminOnly: true },
  { id: 'apikeys',       label: 'User Keys' },
  { id: 'system',        label: 'System' },
  { id: 'snmp',          label: 'SNMP', gapBefore: true },
  { id: 'collectors',    label: 'Collectors' },
  { id: 'oidcatalog',    label: 'OID Catalog' },
  { id: 'hierarchy',     label: 'Hierarchy', adminOnly: true },
]

// ── Top-level sections — Common holds the tabs that used to sit left of the
// divider (gapBefore); the app-specific section holds gapBefore and everything
// after it. Split point is derived from TABS itself, not duplicated here.
type SectionId = 'common' | 'app'
const APP_SECTION_LABEL = 'pktSNMP'
const FIRST_APP_TAB_INDEX = TABS.findIndex(t => t.gapBefore)
const sectionOfTab = (id: TabId): SectionId => {
  const idx = TABS.findIndex(t => t.id === id)
  return idx >= 0 && idx < FIRST_APP_TAB_INDEX ? 'common' : 'app'
}

// ── System tab — open-source notices ──────────────────────────────────────────
const OSS_NOTICES: Array<{ name: string; license: string }> = [
  { name: 'FastAPI',            license: 'MIT' },
  { name: 'Uvicorn',            license: 'BSD-3-Clause' },
  { name: 'Pydantic',           license: 'MIT' },
  { name: 'ClickHouse Driver',  license: 'MIT' },
  { name: 'DuckDB',             license: 'MIT' },
  { name: 'aiosqlite',          license: 'MIT' },
  { name: 'python-jose',        license: 'MIT' },
  { name: 'passlib',            license: 'BSD-2-Clause' },
  { name: 'httpx',              license: 'BSD-3-Clause' },
  { name: 'python3-saml',       license: 'MIT' },
  { name: 'cryptography',       license: 'Apache-2.0 / BSD-3-Clause' },
  { name: 'PyYAML',             license: 'MIT' },
  { name: 'python-dotenv',      license: 'BSD-3-Clause' },
  { name: 'aiosmtplib',         license: 'MIT' },
  { name: 'Jinja2',             license: 'BSD-3-Clause' },
  { name: 'pysnmp-lextudio',    license: 'BSD-2-Clause' },
  { name: 'Paramiko',           license: 'LGPL-2.1' },
  { name: 'python-dateutil',    license: 'BSD / Apache-2.0' },
  { name: 'React',              license: 'MIT' },
  { name: 'React Router',       license: 'MIT' },
  { name: 'Recharts',           license: 'MIT' },
  { name: 'D3.js',              license: 'ISC' },
  { name: 'Lucide Icons',       license: 'ISC' },
  { name: 'clsx',               license: 'MIT' },
  { name: 'Vite',               license: 'MIT' },
  { name: 'Tailwind CSS',       license: 'MIT' },
  { name: 'TypeScript',         license: 'Apache-2.0' },
]

// ── Security tab — its own left-hand vertical tab strip ──────────────────────
type SecurityTabId = 'suite' | 'users' | 'auth' | 'ssl'
const SECURITY_TABS: Array<{ id: SecurityTabId; label: string; adminOnly?: boolean }> = [
  { id: 'users', label: 'Users', adminOnly: true },
  { id: 'auth',  label: 'Auth' },
  { id: 'suite', label: 'Suite Integration' },
  { id: 'ssl',   label: 'SSL / TLS' },
]

// ── Data tab — its own left-hand vertical tab strip ───────────────────────────
type DataTabId = 'storage' | 'backups' | 'logforward'
const DATA_TABS: Array<{ id: DataTabId; label: string }> = [
  { id: 'storage', label: 'Storage' },
  { id: 'backups', label: 'Backups' },
  { id: 'logforward', label: 'Log Forwarding' },
]

// ── Sibling pkt apps (outbound) ─────────────────────────────────────────────────
// Named connections to sibling pkt* apps pktsnmp pulls data from — currently
// just pktIPAM, for the internal-IP lookup in IpLink.tsx. Ported from
// pktflow's own "sibling pkt apps" pattern.
const APP_LABELS: Record<string, string> = {
  pktipam: 'pktIPAM',
}

interface IntegrationFormState {
  name: string; app_name: string; base_url: string; suite_token: string
}

const EMPTY_INTEGRATION: IntegrationFormState = { name: '', app_name: 'pktipam', base_url: '', suite_token: '' }

function IntegrationFormModal({ integration, onClose, onSaved }: {
  integration: Integration | null; onClose: () => void; onSaved: () => void
}) {
  const editing = !!integration
  const [form, setForm] = useState<IntegrationFormState>(
    editing ? { name: integration!.name, app_name: integration!.app_name, base_url: integration!.base_url, suite_token: '' }
            : { ...EMPTY_INTEGRATION }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const setF = <K extends keyof IntegrationFormState>(k: K, v: IntegrationFormState[K]) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (editing) {
        const body: Partial<IntegrationInput> = { name: form.name, base_url: form.base_url }
        if (form.suite_token) body.suite_token = form.suite_token
        await api.updateIntegration(integration!.id, body)
      } else {
        await api.createIntegration(form)
      }
      onSaved()
    } catch (e: any) {
      setError(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inp = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-5">{editing ? `Edit — ${integration!.name}` : 'Add pktIPAM Connection'}</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Name *</label>
            <input value={form.name} onChange={e => setF('name', e.target.value)} required autoFocus
              placeholder="e.g. Main pktIPAM" className={inp} />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Base URL *</label>
            <input value={form.base_url} onChange={e => setF('base_url', e.target.value)} required
              placeholder="http://10.0.0.50:8761" className={inp} />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Suite Token {editing ? '(leave blank to keep)' : '*'}</label>
            <input type="password" value={form.suite_token} onChange={e => setF('suite_token', e.target.value)}
              required={!editing} placeholder="From that pktIPAM's Settings -> Integrations -> Suite Integration" className={inp} />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add Connection')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SiblingIntegrations() {
  const [items, setItems] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'new' | Integration | null>(null)
  const [confirm, setConfirm] = useState<Integration | null>(null)
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    api.getIntegrations().then(setItems).catch(e => setError(e.message)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const del = async (i: Integration) => {
    try {
      await api.deleteIntegration(i.id)
      setConfirm(null)
      load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const test = async (i: Integration) => {
    try {
      const result = await api.testIntegration(i.id)
      setTestResult(prev => ({ ...prev, [i.id]: result.healthy ? `OK — ${result.detail}` : `Failed — ${result.detail}` }))
    } catch (e: any) {
      setTestResult(prev => ({ ...prev, [i.id]: `Failed — ${e.message}` }))
    }
    load()
  }

  if (loading) return <p className="text-xs text-white animate-pulse py-3">Loading…</p>

  return (
    <div className="space-y-3 py-3">
      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      {items.map(i => (
        <div key={i.id} className="bg-gray-800/40 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-white">{i.name}</p>
              <p className="text-xs text-white">{APP_LABELS[i.app_name] ?? i.app_name} · {i.base_url || 'no URL set'}</p>
            </div>
            <span className={i.health_status === 'ok' ? 'text-xs text-emerald-400' : 'text-xs text-white'}>{i.health_status}</span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button onClick={() => test(i)} className="text-xs text-white border border-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-800">Test Connection</button>
            <button onClick={() => setModal(i)} className="text-xs text-white hover:text-blue-400">Edit</button>
            <button onClick={() => setConfirm(i)} className="text-xs text-white hover:text-red-400">Delete</button>
            {testResult[i.id] && <span className="text-xs text-white">{testResult[i.id]}</span>}
          </div>
        </div>
      ))}
      {items.length === 0 && <p className="text-sm text-white py-2">No pktIPAM connections yet.</p>}

      <button onClick={() => setModal('new')}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
        <span className="text-base leading-none">+</span> Add Connection
      </button>

      {modal !== null && (
        <IntegrationFormModal integration={modal === 'new' ? null : modal} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }} />
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold mb-2">Delete connection?</h3>
            <p className="text-white text-sm mb-5">
              Remove <strong className="text-white">{confirm.name}</strong>? Internal-IP lookups will fall back to
              any other enabled pktIPAM connection, or stop working if this was the only one.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-white">Cancel</button>
              <button onClick={() => del(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
// ── End Sibling pkt apps ──────────────────────────────────────────────────────

// ── Suite Integration component ───────────────────────────────────────────────
function PktHubTokenDisplay() {
  const [token, setToken]           = useState('')
  const [revealed, setRevealed]     = useState(false)
  const [copied, setCopied]         = useState(false)
  const [loaded, setLoaded]         = useState(false)
  const [regenerating, setRegen]    = useState(false)

  const regenerate = async () => {
    if (!confirm('Generate a new token?\n\nThe current token will stop working immediately.\nYou will need to re-register this app in pktHub with the new token.')) return
    setRegen(true)
    try {
      const r = await fetch('/api/suite/token/regenerate', { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (d.suite_token) { setToken(d.suite_token); setRevealed(true) }
    } catch {}
    setRegen(false)
  }

  useEffect(() => {
    fetch('/api/suite/token', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setToken(d.suite_token || ''); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  const masked = token
    ? token.slice(0, 6) + '\u2022'.repeat(28) + token.slice(-4)
    : ''

  return (
    <>
      <div className="grid grid-cols-3 gap-4 items-start py-3 border-b border-gray-800">
        <div>
          <p className="text-sm font-medium text-white">Suite Token</p>
          <p className="text-xs text-gray-500 mt-0.5">Copy to pktHub when registering this app</p>
        </div>
        <div className="col-span-2">
          {!loaded && <p className="text-xs text-gray-500 animate-pulse">Loading…</p>}
          {loaded && !token && (
            <p className="text-xs text-yellow-400">No token set — visit this page again after restarting the service.</p>
          )}
          {loaded && token && (
            <div className="flex items-center gap-2 flex-wrap">
              <code className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 break-all">
                {revealed ? token : masked}
              </code>
              <button
                onClick={() => setRevealed(v => !v)}
                className="px-2 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg bg-gray-800 whitespace-nowrap"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <button
                onClick={async () => {
                  const ok = await copyToClipboard(token)
                  if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
                }}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg whitespace-nowrap transition-colors"
                style={{ background: copied ? '#52cc8e' : '#63c3d8' }}
              >
                {copied ? '\u2713 Copied' : 'Copy Token'}
              </button>
              <button
                onClick={regenerate}
                disabled={regenerating}
                title="Generate a new token — you must re-register in pktHub after"
                className="px-2 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 border border-red-800/60 hover:border-red-600 rounded-lg whitespace-nowrap disabled:opacity-40 transition-colors"
              >
                {regenerating ? '\u2026' : 'Regen'}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 items-start py-3">
        <div>
          <p className="text-sm font-medium text-white">How to register</p>
        </div>
        <div className="col-span-2 space-y-1 text-xs text-gray-400">
          <p>1. Copy the token above.</p>
          <p>2. In pktHub &#8594; App Manager &#8594; Register App, enter this app&#39;s URL and paste the token.</p>
          <p>3. pktHub will open this app through its proxy with users automatically signed in.</p>
          <p className="text-gray-500 mt-2 text-xs">&#9888; The token is permanent — it does <em>not</em> change on restart. Use <strong className="text-gray-400">Regenerate</strong> to revoke current access and issue a new token (re-register in pktHub afterwards).</p>
        </div>
      </div>
    </>
  )
}
// ── End Suite Integration ─────────────────────────────────────────────────────


export default function Settings() {
  const { user: me }          = useAuth()
  const isAdmin               = me?.role === 'admin'
  const [searchParams]        = useSearchParams()
  const initialTab            = searchParams.get('tab') as TabId | null
  const [tab, setTab]         = useState<TabId>(initialTab && TABS.some(t => t.id === initialTab) ? initialTab : 'general')
  const [section, setSection] = useState<SectionId>(sectionOfTab(initialTab && TABS.some(t => t.id === initialTab) ? initialTab : 'general'))
  const selectSection = (s: SectionId) => {
    setSection(s)
    const firstVisible = TABS.filter(t => !t.adminOnly || isAdmin).find(t => sectionOfTab(t.id) === s)
    if (firstVisible) setTab(firstVisible.id)
  }
  const [securityTab, setSecurityTab] = useState<SecurityTabId>(isAdmin ? 'users' : 'auth')
  const [dataTab, setDataTab] = useState<DataTabId>('storage')
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const dirtyRef = useRef(false)
  const [systemInfo, setSystemInfo] = useState<{
    app_name: string; version: string; install_dir: string
    github: string; license: string; developer: string; contact: string
  } | null>(null)
  useEffect(() => { api.getSystemInfo().then(setSystemInfo).catch(() => {}) }, [])

  const load = async () => {
    setLoading(true)
    try { setSettings(await api.getSettings()) } finally {
      setLoading(false)
      dirtyRef.current = false
    }
  }
  const silentLoad = async () => {
    if (dirtyRef.current) return
    try { setSettings(await api.getSettings()) } catch {}
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const t = setInterval(silentLoad, 60_000)
    return () => clearInterval(t)
  }, [])

  const set = (key: string, value: unknown) => {
    dirtyRef.current = true
    setSettings(s => ({ ...s, [key]: value }))
  }

  const str  = (k: string, fallback = '') => (settings[k] as string) ?? fallback
  const num  = (k: string, fallback = 0)  => (settings[k] as number) ?? fallback
  const bool = (k: string, fallback = false) => (settings[k] as boolean) ?? fallback

  // Set by pktHub when this app is registered there (POST /api/suite/settings-lock)
  // Don't show the "remotely managed" lockout when pktHub itself is the one
  // viewing this page (via the proxy embed) — only for a real direct visit.
  const hubManaged = bool('hub_settings_managed', false) && me?.authProvider !== 'suite'

  // General tab's Port field lives in config.yaml (not the SQLite settings
  // blob) so it needs its own fetch, but saves through the same one button.
  const [portValue, setPortValue]   = useState(0)
  const [portLoaded, setPortLoaded] = useState(false)
  useEffect(() => {
    api.getPort().then(r => setPortValue(r.port)).catch(() => {}).finally(() => setPortLoaded(true))
  }, [])

  const [generalSaving, setGeneralSaving] = useState(false)
  const [generalSaved, setGeneralSaved]   = useState(false)
  const [generalError, setGeneralError]   = useState('')

  const saveGeneral = async () => {
    if (portValue < 1 || portValue > 65535) { setGeneralError('Enter a port between 1 and 65535'); return }
    setGeneralSaving(true); setGeneralSaved(false); setGeneralError('')
    try {
      const subset: Settings = {}
      for (const k of ['app_name', 'base_url', 'timezone']) if (k in settings) subset[k] = settings[k]
      await api.bulkUpdateSettings(subset)
      await api.setPort(portValue)
      await load()
      setGeneralSaved(true)
      setTimeout(() => setGeneralSaved(false), 3000)
    } catch (e: any) {
      setGeneralError(e.message || 'Save failed')
    } finally {
      setGeneralSaving(false)
    }
  }

  const snmpSave = useSave([
    'snmp_trap_enabled', 'snmp_trap_port', 'snmp_poll_enabled',
    'snmp_poll_default_interval_seconds', 'snmp_poll_max_concurrency',
  ], settings, load)
  const storageSave = useSave([
    'storage_backend', 'retention_days_raw', 'retention_days_hourly', 'alert_event_retention_days',
  ], settings, load)
  const logForwardSave = useSave([
    'log_forward_enabled', 'log_forward_host', 'log_forward_port',
    'log_forward_protocol', 'log_forward_level', 'log_forward_app_name',
  ], settings, load)
  const backupSave = useSave([
    'backup_enabled', 'backup_interval_hours', 'backup_rotation_count', 'backup_path', 'backup_include_clickhouse',
  ], settings, load)
  const authSave = useSave([
    'auth_local_enabled', 'session_timeout_minutes',
    'okta_saml_enabled', 'okta_saml_idp_entity_id', 'okta_saml_idp_sso_url',
    'okta_saml_idp_cert', 'okta_saml_sp_entity_id', 'okta_saml_sp_cert', 'okta_saml_sp_key',
  ], settings, load)
  const resonanceSave = useSave([
    'resonance_enabled', 'resonance_base_url', 'resonance_key', 'resonance_role_levels',
    'resonance_origin', 'resonance_ca_bundle',
    'resonance_style', 'resonance_target', 'resonance_label', 'resonance_side',
    'resonance_width', 'resonance_height', 'resonance_open', 'resonance_exclude_paths',
  ], settings, load)
  // What each role may do with the assistant. Anything unrecognised reads as
  // 'none', matching the server, so a hand-edited value fails closed here too.
  const RESONANCE_DEFAULT_LEVELS = { admin: 'read', analyst: 'read', viewer: 'read' }
  const resonanceLevels =
    (settings['resonance_role_levels'] as Record<string, string>) ?? RESONANCE_DEFAULT_LEVELS
  const resonanceLevel = (role: string) => {
    const level = resonanceLevels[role]
    return level === 'read' || level === 'write' ? level : 'none'
  }
  const setResonanceLevel = (role: string, level: string) =>
    set('resonance_role_levels', { ...resonanceLevels, [role]: level })

  const notifySave = useSave([
    'notify_slack_enabled', 'notify_slack_webhook_url', 'notify_slack_channel',
    'notify_email_enabled', 'notify_email_smtp_host', 'notify_email_smtp_port',
    'notify_email_smtp_tls', 'notify_email_username', 'notify_email_password',
    'notify_email_from', 'notify_email_default_to',
    'notify_pagerduty_enabled', 'notify_pagerduty_integration_key',
    'notify_webhook_enabled', 'notify_webhook_url',
    'notify_webhook_method', 'notify_webhook_payload_template',
    'notify_tracecat_enabled', 'notify_tracecat_webhook_url', 'notify_tracecat_api_token',
  ], settings, load)
  const lucidSave = useSave(['lucid_api_token'], settings, load)

  const [testConnRunning, setTestConnRunning] = useState(false)
  const [testConnResult, setTestConnResult]   = useState<{ ok: boolean; message: string } | null>(null)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupResult, setCleanupResult]   = useState<string | null>(null)
  const [exportRunning, setExportRunning]   = useState(false)
  const [exportError, setExportError]       = useState<string | null>(null)
  // Step-up re-auth before the bundle is generated — it carries config.yaml,
  // i.e. the key to every encrypted secret in the database, alongside it.
  const [exportPrompt, setExportPrompt] = useState(false)
  const [exportPassword, setExportPassword] = useState('')
  const [importFile, setImportFile]         = useState<File | null>(null)
  const [importRunning, setImportRunning]   = useState(false)
  const [importResult, setImportResult]     = useState<Record<string, string> | null>(null)
  const [importError, setImportError]       = useState<string | null>(null)
  const [backupRunning, setBackupRunning]   = useState(false)
  const [backupResult, setBackupResult]     = useState<string | null>(null)
  const [backups, setBackups]               = useState<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>([])
  const [backupsLoaded, setBackupsLoaded]   = useState(false)
  const [snapshotRestoreResult, setSnapshotRestoreResult] = useState<{ name: string; result: Record<string, string> } | null>(null)
  const ALL_BUNDLE_FILES = ['pktsnmp.db', 'config.yaml', 'snmp_data.csv.gz']
  const [importFiles, setImportFiles]       = useState<Set<string>>(new Set(ALL_BUNDLE_FILES))

  const testConnection = async () => {
    setTestConnRunning(true)
    setTestConnResult(null)
    try {
      const r = await api.testStorageConnection()
      setTestConnResult({ ok: r.ok, message: r.message })
    } catch (e: any) {
      setTestConnResult({ ok: false, message: e.message || 'Request failed' })
    } finally { setTestConnRunning(false) }
  }

  const runCleanup = async () => {
    setCleanupRunning(true)
    setCleanupResult(null)
    try {
      const r = await api.runCleanup()
      const parts: string[] = []
      if (r.snmp_data_eligible > 0)
        parts.push(`${r.snmp_data_eligible.toLocaleString()} SNMP data rows queued for deletion`)
      else
        parts.push('No SNMP data beyond retention threshold')
      if (r.alert_events_deleted > 0)
        parts.push(`${r.alert_events_deleted} alert events purged`)
      setCleanupResult(parts.join(' · '))
    } catch (e: any) {
      setCleanupResult(`Error: ${e.message}`)
    } finally { setCleanupRunning(false) }
  }

  const runBackupNow = async () => {
    setBackupRunning(true)
    setBackupResult(null)
    try {
      const r = await api.runBackupNow()
      setBackupResult(`Saved to ${r.path} — ${r.files.join(', ')}`)
      const list = await api.listBackups()
      setBackups(list)
      setBackupsLoaded(true)
    } catch (e: any) {
      setBackupResult(`Error: ${e.message}`)
    } finally { setBackupRunning(false) }
  }

  const loadBackups = async () => {
    try {
      const list = await api.listBackups()
      setBackups(list)
      setBackupsLoaded(true)
    } catch { }
  }

  const runImport = async () => {
    if (!importFile) return
    setImportRunning(true)
    setImportResult(null)
    setImportError(null)
    try {
      const result = await api.importBundle(importFile, Array.from(importFiles))
      setImportResult(result)
    } catch (e: any) {
      setImportError(e.message || 'Import failed')
    } finally { setImportRunning(false) }
  }

  const runExport = async () => {
    setExportRunning(true)
    setExportError(null)
    try {
      const { blob, filename } = await api.exportConfig(exportPassword)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExportPrompt(false)
      setExportPassword('')
    } catch (e: any) {
      setExportError(e.message || 'Export failed')
    } finally { setExportRunning(false) }
  }

  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) silentLoad() }, [tick])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-white">
        <p className="text-sm">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-white">pktSNMP - Settings</h1>

      {/* Section bar */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        <button
          onClick={() => selectSection('common')}
          className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            section === 'common' ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
          }`}
        >
          Common
        </button>
        <button
          onClick={() => selectSection('app')}
          className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            section === 'app' ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
          }`}
        >
          {APP_SECTION_LABEL}
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit overflow-x-auto">
        {TABS.filter(t => (!t.adminOnly || isAdmin) && sectionOfTab(t.id) === section).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              tab === t.id ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {hubManaged && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-amber-800/40 bg-amber-900/20 text-amber-300 text-sm">
          <span className="font-semibold">Remotely Managed</span>
          <span className="text-amber-300/80">— this app is registered with pktHub, which now controls Settings. Make changes from pktHub instead.</span>
        </div>
      )}

      <div className={hubManaged ? 'opacity-40 pointer-events-none select-none' : undefined}>

      {/* General */}
      {tab === 'general' && (
        <Section title="General" onSave={saveGeneral} saving={generalSaving} saved={generalSaved} error={generalError}
          help={{
            title: 'General — How It Works',
            content: <>
              <p><span className="text-gray-300 font-medium">Base URL</span> feeds the SAML ACS/metadata URLs on the Auth tab and any links posted in Slack/Email/webhook notifications — set it to the actual externally-reachable address before configuring SSO or notifications, or those will point at the wrong place.</p>
              <p><span className="text-gray-300 font-medium">Port</span> only takes effect after a restart. Changing it moves the app to a new URL; the browser won't follow automatically.</p>
            </>,
          }}
        >
          <Field label="App name" hint="Displayed in browser tab and header">
            <TextInput value={str('app_name', 'pktSNMP')} onChange={v => set('app_name', v)} />
          </Field>
          <Field label="Timezone" hint="Affects display of timestamps in the UI">
            <SelectInput
              value={str('timezone', 'UTC')}
              onChange={v => set('timezone', v)}
              options={[
                { value: 'UTC', label: 'UTC' },
                { value: 'America/New_York', label: 'Eastern (ET)' },
                { value: 'America/Chicago', label: 'Central (CT)' },
                { value: 'America/Denver', label: 'Mountain (MT)' },
                { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
              ]}
            />
          </Field>
          <PortField value={portValue} onChange={setPortValue} loaded={portLoaded} />
          <Field label="Base URL" hint="Used for redirect URIs and notification links">
            <TextInput value={str('base_url')} onChange={v => set('base_url', v)} placeholder="http://SERVER-IP:8767" />
          </Field>
          <RestartServiceRow />
        </Section>
      )}

      {/* Security */}
      {tab === 'security' && (
        <div className="flex gap-4 items-start">
          <div className="flex flex-col gap-1.5 w-48 flex-shrink-0">
            {SECURITY_TABS.filter(st => !st.adminOnly || isAdmin).map(st => (
              <button
                key={st.id}
                onClick={() => setSecurityTab(st.id)}
                className={`text-sm px-4 py-2 rounded-lg border text-left whitespace-nowrap transition-colors ${
                  securityTab === st.id
                    ? 'bg-gray-800 border-blue-500 text-white'
                    : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {securityTab === 'users' && isAdmin && <UsersTab />}

            {securityTab === 'auth' && (
              <Section title="Authentication" onSave={authSave.save} saving={authSave.saving} saved={authSave.saved} error={authSave.error}
                help={{
                  title: 'Authentication — How It Works',
                  content: <>
                    <p><span className="text-gray-300 font-medium">Local auth</span> and <span className="text-gray-300 font-medium">SAML SSO</span> aren't mutually exclusive — both can be on at once. Turning Local auth off forces everyone through SSO.</p>
                    <p>SAML users are <span className="text-gray-300 font-medium">auto-provisioned</span> on first successful login — no separate "create user" step.</p>
                    <p>Setting this up: paste Okta's IdP metadata XML to auto-fill the IdP fields, then register the <span className="text-gray-300 font-medium">ACS URL</span> shown here as the Single Sign-On URL in your Okta app. Both the ACS URL and SP metadata link derive from <span className="text-gray-300 font-medium">Base URL</span> on the General tab — set that correctly first.</p>
                  </>,
                }}
              >
                <Field label="Local auth" hint="Username/password login using local accounts">
                  <Toggle value={bool('auth_local_enabled', true)} onChange={v => set('auth_local_enabled', v)} />
                </Field>
                <Field label="Session timeout">
                  <div className="flex items-center gap-3">
                    <NumberInput value={num('session_timeout_minutes', 480)} onChange={v => set('session_timeout_minutes', v)} min={5} max={10080} />
                    <span className="text-sm text-white">minutes</span>
                  </div>
                </Field>

                <div className="pt-4 pb-2">
                  <p className="text-xs font-semibold text-white uppercase tracking-wider">Okta SAML 2.0 SSO</p>
                </div>
                <Field label="Enable SAML SSO">
                  <Toggle value={bool('okta_saml_enabled')} onChange={v => set('okta_saml_enabled', v)} />
                </Field>
                {bool('okta_saml_enabled') && (
                  <>
                    <Field label="Paste IdP Metadata XML" hint="Paste the full XML from Okta → Sign On → Identity Provider metadata. Fields below will auto-fill.">
                      <MetadataPasteBox onParsed={(r) => {
                        if (r.entity_id) set('okta_saml_idp_entity_id', r.entity_id)
                        if (r.sso_url)   set('okta_saml_idp_sso_url', r.sso_url)
                        if (r.cert)      set('okta_saml_idp_cert', r.cert)
                      }} />
                    </Field>
                    <Field label="IdP Entity ID" hint="From Okta metadata: Identity Provider Issuer">
                      <TextInput value={str('okta_saml_idp_entity_id')} onChange={v => set('okta_saml_idp_entity_id', v)} placeholder="http://www.okta.com/..." mono />
                    </Field>
                    <Field label="IdP SSO URL" hint="From Okta metadata: Identity Provider Single Sign-On URL">
                      <TextInput value={str('okta_saml_idp_sso_url')} onChange={v => set('okta_saml_idp_sso_url', v)} placeholder="https://yourorg.okta.com/app/.../sso/saml" mono />
                    </Field>
                    <Field label="IdP X.509 Certificate" hint="PEM headers are stripped automatically">
                      <CertTextarea value={str('okta_saml_idp_cert')} onChange={v => set('okta_saml_idp_cert', v)} rows={4} secret />
                    </Field>
                    <Field label="SP Entity ID" hint="Leave blank to use the auto-generated metadata URL">
                      <TextInput value={str('okta_saml_sp_entity_id')} onChange={v => set('okta_saml_sp_entity_id', v)} placeholder={`${str('base_url')}/api/auth/saml/metadata`} mono />
                    </Field>
                    <Field label="ACS URL (read-only)" hint="Register this URL as the Single Sign-On URL in your Okta app">
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={`${str('base_url')}/api/auth/saml/callback`}
                          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400 font-mono cursor-default"
                        />
                        <a href={`${str('base_url')}/api/auth/saml/metadata`} target="_blank" rel="noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap">
                          View SP metadata ↗
                        </a>
                      </div>
                    </Field>
                    <Field label="SP Certificate" hint="Optional: for signed authentication requests">
                      <CertTextarea value={str('okta_saml_sp_cert')} onChange={v => set('okta_saml_sp_cert', v)} rows={3} placeholder="Leave blank if not signing requests" secret />
                    </Field>
                    <Field label="SP Private Key" hint="Optional: private key for signing requests (kept secret)">
                      <CertTextarea value={str('okta_saml_sp_key')} onChange={v => set('okta_saml_sp_key', v)} rows={3} placeholder="Leave blank if not signing requests" secret />
                    </Field>
                  </>
                )}
              </Section>
            )}

            {securityTab === 'ssl' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">SSL / TLS</h2>
                  <HelpButton title="SSL/TLS — How It Works">
                    <p>Accepts either a combined PFX/P12 file or a separate PEM cert+key pair — the running service auto-detects and loads whichever was uploaded at startup.</p>
                  </HelpButton>
                </div>
                <SslPanel sslEnabled={bool('ssl_enabled')} onToggleSSL={v => { set('ssl_enabled', v); api.bulkUpdateSettings({ ssl_enabled: v }).catch(() => {}) }} />
              </div>
            )}

            {securityTab === 'suite' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">Suite Integration</h2>
                  <HelpButton title="Suite Integration — How It Works">
                    <p>One-directional discovery: copy the Suite Token here into pktHub's App Manager when registering this app, so pktHub can proxy into it with users already signed in. Regenerating the token immediately revokes the old one.</p>
                  </HelpButton>
                </div>
                <PktHubTokenDisplay />
              </div>
            )}

            {securityTab === 'suite' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">Sibling pkt Apps</h2>
                  <HelpButton title="Sibling pkt Apps — How It Works">
                    <p>The other direction from the Suite Token above: pktsnmp calling into pktIPAM to look up internal (private) IP addresses — subnet, hostname, DHCP lease, DNS records — the same way it already looks up external IPs via ipinfo.io/AbuseIPDB.</p>
                    <p className="mt-2">In pktIPAM, go to Settings &#8594; Integrations &#8594; Suite Integration and copy its Suite Token, then add a connection here with pktIPAM's base URL and that token. You can add more than one named pktIPAM connection; the first enabled one is used for lookups.</p>
                  </HelpButton>
                </div>
                <SiblingIntegrations />
              </div>
            )}
          </div>
        </div>
      )}

      {/* SNMP */}
      {tab === 'snmp' && (
        <Section title="SNMP" onSave={snmpSave.save} saving={snmpSave.saving} saved={snmpSave.saved} error={snmpSave.error}
          help={{
            title: 'SNMP — How It Works',
            content: <>
              <p>This tab only controls two things running <span className="text-gray-300 font-medium">on this server</span>: the trap receiver and the built-in local polling engine. <span className="text-gray-300 font-medium">Remote otelcol collectors are managed separately</span> under the Collectors tab — they poll independently and aren't affected by anything here.</p>
              <p><span className="text-gray-300 font-medium">Trap port 162</span> is the SNMP standard but needs root or <code className="text-gray-400">cap_net_bind_service</code> to bind — if the trap receiver won't start after enabling it, that's almost always why.</p>
              <p>Both settings on this tab <span className="text-amber-500 font-medium">require a service restart</span> to take effect — toggling or changing the interval here doesn't live-reconfigure the running poller.</p>
            </>,
          }}
        >
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="pt-2 pb-1">
                <p className="text-xs font-semibold text-white uppercase tracking-wider">Trap Receiver</p>
              </div>
              <Field label="Enable trap receiver" hint="Listen for SNMP trap notifications from devices">
                <Toggle value={bool('snmp_trap_enabled')} onChange={v => set('snmp_trap_enabled', v)} />
              </Field>
              {bool('snmp_trap_enabled') && (
                <Field label="Trap port" hint="UDP port to listen for SNMP traps (default 162, requires root or cap_net_bind_service)">
                  <NumberInput value={num('snmp_trap_port', 162)} onChange={v => set('snmp_trap_port', v)} min={1} max={65535} />
                </Field>
              )}
            </div>

            <div className="pl-6 border-l border-gray-800">
              <div className="pt-2 pb-1">
                <p className="text-xs font-semibold text-white uppercase tracking-wider">Local Polling Engine</p>
                <p className="text-xs text-gray-500 mt-0.5">Controls only the built-in poller on this server — does not affect remote otelcol collectors</p>
              </div>
              <Field label="Enable local polling" hint="Run the built-in poll engine on this server (O2). Remote collectors are unaffected.">
                <Toggle value={bool('snmp_poll_enabled')} onChange={v => set('snmp_poll_enabled', v)} />
              </Field>
              {bool('snmp_poll_enabled') && (
                <>
                  <Field label="Poll interval" hint="Seconds between local poll cycles">
                    <div className="flex items-center gap-3">
                      <NumberInput value={num('snmp_poll_default_interval_seconds', 60)} onChange={v => set('snmp_poll_default_interval_seconds', v)} min={10} max={86400} />
                      <span className="text-sm text-white">seconds</span>
                    </div>
                  </Field>
                  <Field label="Max concurrency" hint="Maximum number of SNMP polls in flight at once">
                    <NumberInput value={num('snmp_poll_max_concurrency', 10)} onChange={v => set('snmp_poll_max_concurrency', v)} min={1} max={200} />
                  </Field>
                </>
              )}
            </div>
          </div>

          <div className="py-4">
            <p className="text-xs text-blue-400 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
              Trap receiver and local polling engine settings only. Remote otelcol collectors operate independently and are managed under the <span className="font-semibold">Collectors</span> tab. Changes here take effect after a service restart.
            </p>
          </div>

          <div className="pt-4">
            <TabErrorBoundary><CredentialsTab /></TabErrorBoundary>
          </div>
        </Section>
      )}

      {/* Data */}
      {tab === 'data' && (
        <div className="flex gap-4 items-start">
          <div className="flex flex-col gap-1.5 w-48 flex-shrink-0">
            {DATA_TABS.map(dt => (
              <button
                key={dt.id}
                onClick={() => setDataTab(dt.id)}
                className={`text-sm px-4 py-2 rounded-lg border text-left whitespace-nowrap transition-colors ${
                  dataTab === dt.id
                    ? 'bg-gray-800 border-blue-500 text-white'
                    : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
                }`}
              >
                {dt.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
      {dataTab === 'storage' && (
        <Section title="Storage" onSave={storageSave.save} saving={storageSave.saving} saved={storageSave.saved} error={storageSave.error}
          help={{
            title: 'Storage — How It Works',
            content: <>
              <p>Switching <span className="text-gray-300 font-medium">Backend</span> requires a service restart to actually take effect — the running process picks its storage driver once at startup, so saving this field alone won't move any data.</p>
              <p><span className="text-gray-300 font-medium">SQLite is genuinely the default</span> for this app, unlike ClickHouse/DuckDB which exist for larger analytical workloads — most device counts never need to change this.</p>
              <p>Retention days apply per-tier — raw SNMP records are usually kept far shorter than hourly rollups. <span className="text-gray-300 font-medium">Manual cleanup</span> applies current thresholds immediately instead of waiting for the next scheduled pass.</p>
            </>,
          }}
        >
          <Field label="Backend" hint="SQLite is the default — stable, zero-config, sufficient for all device counts. DuckDB and ClickHouse are available for advanced analytics. A service restart is required after changing this setting.">
            <SelectInput
              value={str('storage_backend', 'sqlite')}
              onChange={v => set('storage_backend', v)}
              options={[
                { value: 'sqlite', label: 'SQLite (default)' },
                { value: 'duckdb', label: 'DuckDB (analytical workloads)' },
                { value: 'clickhouse', label: 'ClickHouse (requires separate install)' },
              ]}
            />
          </Field>
          <Field label="Test connection" hint="Verify the backend is reachable">
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={testConnection} disabled={testConnRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                {testConnRunning ? 'Testing…' : 'Test Connection'}
              </button>
              {testConnResult && (
                <span className={`text-xs ${testConnResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                  {testConnResult.ok ? '✓ ' : '✗ '}{testConnResult.message}
                </span>
              )}
            </div>
          </Field>
          <Field label="Raw data retention" hint="Days to keep individual SNMP data records">
            <div className="flex items-center gap-3">
              <NumberInput value={num('retention_days_raw', 90)} onChange={v => set('retention_days_raw', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Hourly rollup retention" hint="Days to keep per-hour aggregated data">
            <div className="flex items-center gap-3">
              <NumberInput value={num('retention_days_hourly', 365)} onChange={v => set('retention_days_hourly', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Alert event retention" hint="Days to keep fired alert events and notification logs">
            <div className="flex items-center gap-3">
              <NumberInput value={num('alert_event_retention_days', 90)} onChange={v => set('alert_event_retention_days', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Manual cleanup" hint="Immediately apply current retention settings">
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={runCleanup} disabled={cleanupRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                {cleanupRunning ? 'Running…' : 'Run Cleanup Now'}
              </button>
              {cleanupResult && (
                <span className={`text-xs ${cleanupResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {cleanupResult}
                </span>
              )}
            </div>
          </Field>

        </Section>
      )}

      {/* Backup */}
      {dataTab === 'logforward' && (
        <Section title="Log Forwarding" onSave={logForwardSave.save} saving={logForwardSave.saving} saved={logForwardSave.saved} error={logForwardSave.error}
          help={{
            title: 'Log Forwarding — How It Works',
            content: <>
              <p>Ships pktSNMP's own application log to a syslog collector — normally <span className="text-gray-300 font-medium">pktLog</span>, which listens on port <code className="text-gray-400">5514</code> — so this app's logs sit alongside the rest of the estate instead of only in its local Logs page.</p>
              <p>Messages are sent as <span className="text-gray-300 font-medium">RFC 5424</span>. pktLog also parses RFC 3164, but 3164 timestamps carry no timezone and the collector has to guess the offset; 5424 carries a full offset so there is nothing to guess.</p>
              <p>Delivery is fire-and-forget on a background thread — if the collector is unreachable, lines are dropped and counted rather than blocking or crashing pktSNMP. Use <span className="text-gray-300 font-medium">Send test message</span> to confirm the path end to end.</p>
              <p>Local logging is unaffected: records continue to be written to the in-app Logs page regardless of this setting.</p>
            </>,
          }}
        >
          <Field label="Forward app logs" hint="Send this app's log records to a syslog collector (e.g. pktLog)">
            <Toggle value={bool('log_forward_enabled')} onChange={v => set('log_forward_enabled', v)} />
          </Field>
          <Field label="Collector host" hint="Hostname or IP of the pktLog / syslog collector">
            <TextInput value={str('log_forward_host')} onChange={v => set('log_forward_host', v)} placeholder="10.0.0.10" />
          </Field>
          <Field label="Port" hint="pktLog listens on 5514 by default">
            <NumberInput value={num('log_forward_port', 5514)} onChange={v => set('log_forward_port', v)} min={1} max={65535} />
          </Field>
          <Field label="Protocol" hint="UDP is fire-and-forget; TCP confirms delivery to the collector">
            <SelectInput value={str('log_forward_protocol') || 'udp'} onChange={v => set('log_forward_protocol', v)}
                    options={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }]} />
          </Field>
          <Field label="Minimum level" hint="Records below this level are not forwarded">
            <SelectInput value={str('log_forward_level') || 'INFO'} onChange={v => set('log_forward_level', v)}
                    options={[
                      { value: 'DEBUG', label: 'Debug' }, { value: 'INFO', label: 'Info' },
                      { value: 'WARNING', label: 'Warning' }, { value: 'ERROR', label: 'Error' },
                    ]} />
          </Field>
          <Field label="Application name" hint="Appears as the APP-NAME field in the syslog message">
            <TextInput value={str('log_forward_app_name') || 'pktsnmp'} onChange={v => set('log_forward_app_name', v)} placeholder="pktsnmp" />
          </Field>
          <LogForwardTester
            host={str('log_forward_host')}
            port={num('log_forward_port', 5514)}
            protocol={str('log_forward_protocol') || 'udp'}
          />
        </Section>
      )}

      {dataTab === 'backups' && (
        <Section title="Backup" onSave={backupSave.save} saving={backupSave.saving} saved={backupSave.saved} error={backupSave.error}
          help={{
            title: 'Backup — How It Works',
            content: <>
              <p>A backup always includes the SQLite database (settings, devices, credentials, users, alert rules, hierarchy) and <code className="text-gray-400">config.yaml</code>. <span className="text-gray-300 font-medium">Include ClickHouse data</span> additionally exports SNMP data history — worth disabling if you only care about configuration, since data history is usually the largest part.</p>
              <p><span className="text-gray-300 font-medium">Rotation count</span> caps how many snapshots (scheduled or manual) stay on disk — the oldest is deleted automatically once you exceed it.</p>
              <p><span className="text-gray-300 font-medium">Export bundle</span> is a one-off download, separate from the rotation-managed snapshots above. <span className="text-amber-500 font-medium">Restore always requires a service restart</span> afterward for config changes in the bundle to apply.</p>
              <p>Snapshots above can be restored directly from the server — no download/upload round trip needed. Both that and the bundle upload let you pick which files to restore instead of always restoring everything.</p>
            </>,
          }}
        >
          <Field label="Auto backup" hint="Run a scheduled backup on the server at the configured interval">
            <Toggle value={bool('backup_enabled')} onChange={v => set('backup_enabled', v)} />
          </Field>
          <Field label="Interval" hint="Hours between automatic backup runs">
            <div className="flex items-center gap-3">
              <NumberInput value={num('backup_interval_hours', 24)} onChange={v => set('backup_interval_hours', v)} min={1} max={720} />
              <span className="text-sm text-white">hours</span>
            </div>
          </Field>
          <Field label="Rotation count" hint="Number of snapshots to keep — oldest deleted when exceeded">
            <NumberInput value={num('backup_rotation_count', 5)} onChange={v => set('backup_rotation_count', v)} min={1} max={100} />
          </Field>
          <Field label="Backup path" hint="Directory on server where snapshots are stored">
            <TextInput value={str('backup_path')} onChange={v => set('backup_path', v)} mono />
          </Field>
          <Field label="Include ClickHouse data" hint="Export SNMP data history into each snapshot (can be large)">
            <Toggle value={bool('backup_include_clickhouse', true)} onChange={v => set('backup_include_clickhouse', v)} />
          </Field>
          <Field label="Manual backup" hint="Trigger a backup run immediately using current settings">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={runBackupNow} disabled={backupRunning}
                  className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  {backupRunning ? 'Running…' : 'Run Backup Now'}
                </button>
                {!backupsLoaded && !backupRunning && (
                  <button onClick={loadBackups} className="text-xs text-white hover:text-white underline">
                    Show snapshots
                  </button>
                )}
              </div>
              {backupResult && (
                <p className={`text-xs ${backupResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {backupResult}
                </p>
              )}
              {backupsLoaded && (
                <div className="space-y-1">
                  {backups.length === 0 ? (
                    <p className="text-xs text-white">No snapshots found.</p>
                  ) : backups.map(b => (
                    <SnapshotRestoreRow key={b.name} snapshot={b} onRestored={(name, result) => setSnapshotRestoreResult({ name, result })} />
                  ))}
                </div>
              )}
              {snapshotRestoreResult && (
                <div className="text-xs space-y-1 bg-gray-800/60 rounded-lg p-3">
                  <p className="text-white">Restored from {snapshotRestoreResult.name}:</p>
                  {Object.entries(snapshotRestoreResult.result).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-white">{k}:</span>{' '}
                      <span className={v.startsWith('error') || v.startsWith('not found') ? 'text-red-400' : 'text-green-400'}>{v}</span>
                    </p>
                  ))}
                  <p className="text-amber-400 mt-1">Restart the service to apply any config changes.</p>
                </div>
              )}
            </div>
          </Field>
          <Field label="Export bundle" hint="Download pktsnmp.db + config.yaml + ClickHouse SNMP data as a .tar.gz">
            <div className="flex items-center gap-3 flex-wrap">
              {!exportPrompt ? (
                <button onClick={() => { setExportPassword(''); setExportError(null); setExportPrompt(true) }}
                  className="bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  Download Export
                </button>
              ) : (
                <div className="flex flex-col gap-2 w-full">
                  <p className="text-xs text-amber-300/90">
                    This bundle contains the database <em>and</em> config.yaml — every encrypted secret plus the
                    key that decrypts them. Confirm your password to download it, then store it as carefully as
                    you would the secrets themselves.
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="password" value={exportPassword} autoComplete="current-password"
                      onChange={e => setExportPassword(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && exportPassword) runExport() }}
                      placeholder="Your current password"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" />
                    <button onClick={runExport} disabled={exportRunning || !exportPassword}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                      {exportRunning ? 'Generating…' : 'Confirm & Download'}
                    </button>
                    <button onClick={() => { setExportPrompt(false); setExportPassword(''); setExportError(null) }}
                      className="text-white hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {exportError && <span className="text-xs text-red-400">{exportError}</span>}
            </div>
          </Field>
          <Field label="Restore from bundle" hint="Upload a pktsnmp export .tar.gz to restore SQLite, config, and SNMP data. Restart service after restore.">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg px-4 py-2 transition-colors cursor-pointer">
                  {importFile ? importFile.name : 'Choose .tar.gz…'}
                  <input
                    type="file"
                    accept=".tar.gz,.tgz"
                    className="hidden"
                    onChange={e => {
                      setImportFile(e.target.files?.[0] ?? null)
                      setImportResult(null)
                      setImportError(null)
                    }}
                  />
                </label>
                <button onClick={runImport} disabled={!importFile || importRunning || importFiles.size === 0}
                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  {importRunning ? 'Restoring…' : 'Restore'}
                </button>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-white">
                {ALL_BUNDLE_FILES.map(f => (
                  <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={importFiles.has(f)}
                      onChange={() => setImportFiles(prev => {
                        const next = new Set(prev)
                        if (next.has(f)) next.delete(f); else next.add(f)
                        return next
                      })}
                      className="accent-amber-600"
                    />
                    <span className="font-mono">{f}</span>
                  </label>
                ))}
              </div>
              {importError && <p className="text-xs text-red-400">{importError}</p>}
              {importResult && (
                <div className="text-xs space-y-1">
                  {Object.entries(importResult).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-white capitalize">{k}:</span>{' '}
                      <span className={v.startsWith('error') ? 'text-red-400' : 'text-green-400'}>{v}</span>
                    </p>
                  ))}
                  <p className="text-amber-400 mt-1">Restart the service to apply any config changes.</p>
                </div>
              )}
            </div>
          </Field>
        </Section>
      )}
          </div>
        </div>
      )}

      {/* Notifications */}
      {tab === 'notifications' && (
        <Section title="Notifications" onSave={notifySave.save} saving={notifySave.saving} saved={notifySave.saved} error={notifySave.error}
          help={{
            title: 'Notifications — How It Works',
            content: <>
              <p>These five channels — Slack, Email, PagerDuty, generic Webhook, and TraceCat SOAR — are what an <span className="text-gray-300 font-medium">Alert rule</span> (Alerts page) actually dispatches to when it fires. Enabling a channel here doesn't send anything by itself; it makes the channel available to alert rules.</p>
              <p><span className="text-gray-300 font-medium">Send Test</span> is a real dispatch, not a dry run — it posts to Slack, sends actual SMTP, fires a PagerDuty event, etc., using whatever's currently filled in above even if unsaved.</p>
              <p><span className="text-gray-300 font-medium">Webhook payload template</span> is Jinja2 — reference <code className="text-gray-400">alert_name</code>, <code className="text-gray-400">message</code>, <code className="text-gray-400">severity</code>, and <code className="text-gray-400">fired_at</code>.</p>
            </>,
          }}
        >
          {/* Slack */}
          <div className="pt-2 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Slack</p>
          </div>
          <Field label="Enable Slack">
            <Toggle value={bool('notify_slack_enabled')} onChange={v => set('notify_slack_enabled', v)} />
          </Field>
          {bool('notify_slack_enabled') && (
            <>
              <Field label="Webhook URL">
                <TextInput value={str('notify_slack_webhook_url')} onChange={v => set('notify_slack_webhook_url', v)} placeholder="https://hooks.slack.com/services/…" secret mono />
              </Field>
              <Field label="Channel" hint="Override channel (optional)">
                <TextInput value={str('notify_slack_channel', '#alerts')} onChange={v => set('notify_slack_channel', v)} placeholder="#alerts" />
              </Field>
              <SendTestButton channel="slack" />
            </>
          )}

          {/* Email */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Email (SMTP)</p>
          </div>
          <Field label="Enable email">
            <Toggle value={bool('notify_email_enabled')} onChange={v => set('notify_email_enabled', v)} />
          </Field>
          {bool('notify_email_enabled') && (
            <>
              <Field label="SMTP host"><TextInput value={str('notify_email_smtp_host')} onChange={v => set('notify_email_smtp_host', v)} placeholder="smtp.yourorg.com" mono /></Field>
              <Field label="SMTP port"><NumberInput value={num('notify_email_smtp_port', 587)} onChange={v => set('notify_email_smtp_port', v)} min={1} max={65535} /></Field>
              <Field label="Use TLS"><Toggle value={bool('notify_email_smtp_tls', true)} onChange={v => set('notify_email_smtp_tls', v)} /></Field>
              <Field label="Username"><TextInput value={str('notify_email_username')} onChange={v => set('notify_email_username', v)} mono /></Field>
              <Field label="Password"><TextInput value={str('notify_email_password')} onChange={v => set('notify_email_password', v)} secret /></Field>
              <Field label="From address"><TextInput value={str('notify_email_from')} onChange={v => set('notify_email_from', v)} placeholder="pktsnmp@yourorg.com" /></Field>
              <Field label="Default to" hint="Comma-separated email addresses">
                <TextInput
                  value={Array.isArray(settings['notify_email_default_to']) ? (settings['notify_email_default_to'] as string[]).join(', ') : ''}
                  onChange={v => set('notify_email_default_to', v.split(',').map(s => s.trim()).filter(Boolean))}
                  placeholder="noc@yourorg.com, security@yourorg.com"
                />
              </Field>
              <SendTestButton channel="email" />
            </>
          )}

          {/* PagerDuty */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">PagerDuty</p>
          </div>
          <Field label="Enable PagerDuty">
            <Toggle value={bool('notify_pagerduty_enabled')} onChange={v => set('notify_pagerduty_enabled', v)} />
          </Field>
          {bool('notify_pagerduty_enabled') && (
            <>
              <Field label="Integration key" hint="Events API v2 integration key">
                <TextInput value={str('notify_pagerduty_integration_key')} onChange={v => set('notify_pagerduty_integration_key', v)} secret mono />
              </Field>
              <SendTestButton channel="pagerduty" />
            </>
          )}

          {/* Webhook */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Webhook</p>
          </div>
          <Field label="Enable webhook">
            <Toggle value={bool('notify_webhook_enabled')} onChange={v => set('notify_webhook_enabled', v)} />
          </Field>
          {bool('notify_webhook_enabled') && (
            <>
              <Field label="URL">
                <TextInput value={str('notify_webhook_url')} onChange={v => set('notify_webhook_url', v)} placeholder="https://yourservice.com/pktsnmp-alert" mono />
              </Field>
              <Field label="Method">
                <SelectInput value={str('notify_webhook_method', 'POST')} onChange={v => set('notify_webhook_method', v)}
                  options={[{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }]} />
              </Field>
              <Field label="Payload template" hint="Jinja2 template; vars: alert_name, message, severity, fired_at">
                <textarea value={str('notify_webhook_payload_template')} onChange={e => set('notify_webhook_payload_template', e.target.value)}
                  rows={4} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </Field>
              <SendTestButton channel="webhook" />
            </>
          )}

          {/* TraceCat */}
          <div className="pt-2 pb-1">
            <p className="text-sm font-medium text-white">TraceCat SOAR</p>
          </div>
          <Field label="Enable TraceCat">
            <Toggle value={bool('notify_tracecat_enabled')} onChange={v => set('notify_tracecat_enabled', v)} />
          </Field>
          {bool('notify_tracecat_enabled') && (
            <>
              <Field label="Webhook URL" hint="Paste the workflow webhook URL from TraceCat → Workflow → Trigger">
                <TextInput value={str('notify_tracecat_webhook_url')} onChange={v => set('notify_tracecat_webhook_url', v)} placeholder="https://tracecat.yourorg.com/api/v1/webhooks/…" mono />
              </Field>
              <Field label="API token" hint="Bearer token for TraceCat API authentication (optional if webhook is public)">
                <TextInput value={str('notify_tracecat_api_token')} onChange={v => set('notify_tracecat_api_token', v)} secret />
              </Field>
              <SendTestButton channel="tracecat" />
            </>
          )}
        </Section>
      )}

      {/* User Keys tab — personal keys plus the app-wide Lucidchart token */}
      {tab === 'resonance' && (
        <>
        <Section title="Resonance" onSave={resonanceSave.save} saving={resonanceSave.saving} saved={resonanceSave.saved} error={resonanceSave.error}
          help={{
            title: 'Resonance — How It Works',
            content: <>
              <p>Resonance is the shared assistant surface for the pkt suite. It mounts as a launcher in the corner of every page, but the assistant itself runs on the resonance server rather than inside pktSNMP.</p>
              <p><span className="text-gray-300 font-medium">Resonance AI Interface Server</span> is the interface resonance serves embeds from — <span className="text-amber-500 font-medium">not its admin portal</span>, which usually answers on a different address and will look almost right: it serves <code>embed.js</code> too, and only fails later with a &ldquo;not found&rdquo; on the session call. Whatever is typed into SETTINGS → ENROLL → Enroll Embed Server on resonance goes here character for character, because <code>embed.js</code> derives its own origin from that string. Leave the port off if it sits behind a reverse proxy.</p>
              <p><span className="text-gray-300 font-medium">pktSNMP&rsquo;s own address</span> is what a browser types to reach this app, and it is the string that has to appear on the resonance key&rsquo;s origins list. Leave it blank and pktSNMP works it out from the request — correct for a direct install, and wrong behind a reverse proxy, where it sees the internal address rather than the one users type.</p>
              <p><span className="text-gray-300 font-medium">pktSNMP never sends your login credentials.</span> It vouches for whoever is signed in and receives a short-lived, single-use code the browser spends on opening the widget. The key below never reaches the browser.</p>
              <p><span className="text-gray-300 font-medium">The panel&rsquo;s insides belong to resonance.</span> It is an iframe served from resonance&rsquo;s own origin, so pktSNMP cannot restyle it or move its controls — where the buttons sit is a resonance change. What pktSNMP can do is make the panel bigger, with <span className="text-gray-300 font-medium">Panel size</span>, which is usually what &ldquo;more room to read&rdquo; actually needs.</p>
              <p><span className="text-amber-500 font-medium">What the assistant will discuss is configured in resonance, not here.</span> The subjects it will engage with are set by the profile the key is authorised against.</p>
              <p><span className="text-gray-300 font-medium">The assistant can read this install&rsquo;s data.</span> The devices pktSNMP polls and one device in full, the interfaces discovered on a device, the collectors doing the polling, the estate summary, alert rules and the alerts they have fired, and pktSNMP&rsquo;s own diagnostic log. Each call is made by this page on the session of whoever is signed in, so it reaches only what that person could already open. The list is published at <code>/.well-known/resonance.json</code> and is fixed in the code rather than configurable — but it is inert unless <span className="text-gray-300 font-medium">Enabled</span> is on and the person&rsquo;s role is above <span className="text-gray-300 font-medium">No access</span> below.</p>
              <p><span className="text-amber-500 font-medium">No SNMP credential ever leaves through it</span> — not a community string, not a v3 auth or privacy key, and not a collector&rsquo;s SSH key or API token. Nothing it can call creates, edits or deletes a device, collector, credential or OID, and nothing polls a device on demand.</p>
              <p><span className="text-gray-300 font-medium">Read and write adds three operations, and no more.</span> Acknowledge one alert, acknowledge all of them, and switch an existing alert rule on or off. Resonance stops and reads the real values back to the person before running any of them.</p>
              <p><span className="text-gray-300 font-medium">A level never exceeds the role.</span> Two checks have to agree: the level set here, and pktSNMP&rsquo;s own rule for the thing being done. Setting a level does not grant anybody a right they did not already have — it decides whether the assistant may use the rights they do.</p>
              <p>Where no role is set to <span className="text-gray-300 font-medium">Read and write</span>, the write operations are withheld from the published grant altogether, so nothing at the resonance end can be ticked into offering them.</p>
              <p>Answers are capped so a conversation stays readable: a page plus the true count, trimmed again if it would be too large to carry, and the assistant is told when that happened so it narrows the question rather than showing half an answer. Documentation is published separately at <code>/api/resonance/docs</code>, so pointing resonance at it keeps what the assistant knows in step with the installed version.</p>
              <p>Resonance must be reachable from the <span className="text-gray-300 font-medium">browser</span>, over HTTPS, with a certificate those browsers already trust. An untrusted certificate produces an empty widget with nothing in the console to explain it.</p>
              <p><span className="text-gray-300 font-medium">pktSNMP also calls resonance directly</span>, server to server, so this host must be able to resolve resonance&rsquo;s name and trust its certificate — the browser doing both is not enough. Python verifies against its own bundled roots rather than the system store, so a certificate signed by an internal CA is trusted by every browser on the network and still rejected here. <span className="text-gray-300 font-medium">CA bundle</span> points it at the system store instead; on Debian and Ubuntu that is <code>/etc/ssl/certs/ca-certificates.crt</code>.</p>
            </>,
          }}
        >
          <Field label="Enabled" hint="Show the launcher to users. Separate from Test Connection on purpose.">
            <Toggle value={bool('resonance_enabled')} onChange={v => set('resonance_enabled', v)} />
          </Field>
          <Field label="Resonance AI Interface Server" hint="The interface server, not the admin portal — they are different addresses.">
            <TextInput value={str('resonance_base_url')} onChange={v => set('resonance_base_url', v)} placeholder="https://resonance.example.com" mono />
          </Field>
          <Field label="Key" hint="Issued by resonance, one per placement. Never sent to the browser.">
            <TextInput value={str('resonance_key')} onChange={v => set('resonance_key', v)} placeholder="e0000000000.…" secret mono />
          </Field>
          <Field label="pktSNMP's own address" hint="What browsers type to reach pktSNMP. Copy it onto the resonance key.">
            <ResonanceOriginField value={str('resonance_origin')} onChange={v => set('resonance_origin', v)} />
          </Field>
          <Field label="CA bundle" hint="Only needed if resonance uses an internal CA. Blank trusts public CAs only.">
            <TextInput value={str('resonance_ca_bundle')} onChange={v => set('resonance_ca_bundle', v)} placeholder="/etc/ssl/certs/ca-certificates.crt" mono />
          </Field>
          <Field label="What each role can do" hint="No access hides the launcher entirely. Read only lets the assistant look. Read and write also lets it act — never beyond what that role can already do in pktSNMP.">
            <div className="space-y-2">
              {['admin', 'analyst', 'viewer'].map(role => (
                <div key={role} className="flex items-center gap-3">
                  <span className="w-20 text-sm text-white">{role}</span>
                  <SelectInput
                    value={resonanceLevel(role)}
                    onChange={v => setResonanceLevel(role, v)}
                    options={[
                      { value: 'none',  label: 'No access' },
                      { value: 'read',  label: 'Read only' },
                      { value: 'write', label: 'Read and write' },
                    ]}
                  />
                </div>
              ))}
            </div>
          </Field>
          <Field label="Placement" hint="Bubble is a launcher in the corner. Inline renders into an element you name instead.">
            <SelectInput
              value={str('resonance_style', 'bubble')}
              onChange={v => set('resonance_style', v)}
              options={[{ value: 'bubble', label: 'Bubble' }, { value: 'inline', label: 'Inline' }]}
            />
          </Field>
          {str('resonance_style', 'bubble') === 'inline' && (
            <Field label="Target element" hint="id of an element that already exists. Without it nothing mounts.">
              <TextInput value={str('resonance_target')} onChange={v => set('resonance_target', v)} mono />
            </Field>
          )}
          <Field label="Side" hint="Which corner the launcher sits in.">
            <SelectInput
              value={str('resonance_side', 'right')}
              onChange={v => set('resonance_side', v)}
              options={[{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }]}
            />
          </Field>
          <Field label="Label" hint="Optional text on the launcher.">
            <TextInput value={str('resonance_label')} onChange={v => set('resonance_label', v)} />
          </Field>
          <Field label="Panel size" hint="Width and height of the open panel. Blank uses resonance's defaults.">
            <div className="flex items-center gap-2">
              <TextInput value={str('resonance_width')} onChange={v => set('resonance_width', v)} placeholder="420" mono />
              <span className="text-xs text-gray-500">&times;</span>
              <TextInput value={str('resonance_height')} onChange={v => set('resonance_height', v)} placeholder="640" mono />
            </div>
          </Field>
          <Field label="Open on load" hint="Show the panel expanded rather than waiting for a click.">
            <Toggle value={bool('resonance_open')} onChange={v => set('resonance_open', v)} />
          </Field>
          <Field label="Hide on pages" hint="Comma-separated paths. Listing a page discards conversations on it.">
            <TextInput
              value={((settings['resonance_exclude_paths'] as string[]) ?? ['/login']).join(', ')}
              onChange={v => set('resonance_exclude_paths', v.split(',').map(x => x.trim()).filter(Boolean))}
              mono
            />
          </Field>
        </Section>
        <ResonanceDiagnostics baseUrl={str('resonance_base_url')} keyValue={str('resonance_key')} />
        </>
      )}

      {tab === 'apikeys' && (
        <ApiKeysTab
          lucidToken={str('lucid_api_token')}
          onLucidChange={v => set('lucid_api_token', v)}
          lucidSave={lucidSave}
        />
      )}

      {/* System — version/about info */}
      {tab === 'system' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 grid grid-cols-3 gap-4 items-center">
              <h2 className="text-sm font-semibold text-white">System: {systemInfo?.app_name ?? 'pktSNMP'}</h2>
              <div className="col-span-2">
                <BrandLockup markSize={32} descriptor={null} />
              </div>
            </div>
            <div className="px-6 py-2">
              <Field label="Version">
                <p className="text-sm text-white font-mono">v{systemInfo?.version ?? '—'}</p>
              </Field>
              <Field label="Directory">
                <p className="text-sm text-white font-mono break-all">{systemInfo?.install_dir ?? '—'}</p>
              </Field>
              <Field label="Github">
                {systemInfo?.github ? (
                  <a href={systemInfo.github} target="_blank" rel="noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 break-all">{systemInfo.github}</a>
                ) : <p className="text-sm text-white">—</p>}
              </Field>
              <Field label="License">
                <p className="text-sm text-white">{systemInfo?.license ?? '—'}</p>
              </Field>
              <Field label="Developer">
                <p className="text-sm text-white">{systemInfo?.developer ?? '—'}</p>
              </Field>
              <Field label="Contact">
                {systemInfo?.contact ? (
                  <a href={`mailto:${systemInfo.contact}`}
                    className="text-sm text-blue-400 hover:text-blue-300">{systemInfo.contact}</a>
                ) : <p className="text-sm text-white">—</p>}
              </Field>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">Licenses &amp; Copyright</h2>
            </div>
            <div className="px-6 py-4">
              <p className="text-xs text-gray-400 mb-3">
                {systemInfo?.app_name ?? 'pktSNMP'} is built with the following open-source software:
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs text-gray-300 font-mono">
                {OSS_NOTICES.map(n => (
                  <div key={n.name} className="flex justify-between gap-2">
                    <span>{n.name}</span>
                    <span className="text-gray-500">{n.license}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden px-6 py-6 flex items-center justify-center">
            <img src="barsoftnetware-logo.png" alt="Barsoft Netware" className="h-56 w-auto" />
          </div>
        </div>
      )}

      {/* Collectors — remote otelcol collector management, moved here from the left nav */}
      {tab === 'collectors' && <TabErrorBoundary><Collectors /></TabErrorBoundary>}

      {/* OID Catalog */}
      {tab === 'oidcatalog' && <TabErrorBoundary><OidCatalog /></TabErrorBoundary>}

      {/* Hierarchy tab — admin only */}
      {tab === 'hierarchy' && isAdmin && <TabErrorBoundary><HierarchyTab /></TabErrorBoundary>}
      </div>
    </div>
  )
}

// ── SSL certificate upload ─────────────────────────────────────────────────────

function SslDropZone({ label, accept, file, onFile, dragging, onDrag }: {
  label: string; accept: string; file: File | null
  onFile: (f: File) => void; dragging: boolean; onDrag: (v: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`flex-1 border-2 border-dashed rounded-xl p-5 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors select-none ${
        dragging    ? 'border-blue-500 bg-blue-500/10'
        : file      ? 'border-green-600 bg-green-600/10'
        : 'border-gray-700 hover:border-gray-600'
      }`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); onDrag(true) }}
      onDragLeave={() => onDrag(false)}
      onDrop={e => { e.preventDefault(); onDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      {file ? (
        <>
          <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <p className="text-xs font-medium text-green-400 text-center break-all">{file.name}</p>
          <p className="text-xs text-white">{(file.size / 1024).toFixed(1)} KB</p>
        </>
      ) : (
        <>
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
          </svg>
          <p className="text-xs font-medium text-white text-center">{label}</p>
          <p className="text-xs text-white">Drop or click to browse</p>
        </>
      )}
    </div>
  )
}

function SslPanel({ sslEnabled, onToggleSSL }: { sslEnabled: boolean; onToggleSSL: (v: boolean) => void }) {
  const [status, setStatus]       = useState<SslStatus | null>(null)
  const [mode, setMode]           = useState<'pem' | 'pfx'>('pfx')
  const [certFile, setCertFile]   = useState<File | null>(null)
  const [keyFile,  setKeyFile]    = useState<File | null>(null)
  const [certDrag, setCertDrag]   = useState(false)
  const [keyDrag,  setKeyDrag]    = useState(false)
  const [pfxFile,  setPfxFile]    = useState<File | null>(null)
  const [pfxDrag,  setPfxDrag]    = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [uploading, setUploading] = useState(false)
  const [removing,  setRemoving]  = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getSslStatus().then(setStatus).catch(() => setStatus({ installed: false }))
  }, [])

  const uploadPem = async () => {
    if (!certFile || !keyFile) return
    setUploading(true); setMsg(null)
    try {
      const s = await api.uploadSsl(certFile, keyFile)
      setStatus(s); setCertFile(null); setKeyFile(null)
      setMsg({ ok: true, text: 'Certificate installed. Restart the service (General tab) to enable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Upload failed' })
    } finally { setUploading(false) }
  }

  const uploadPfx = async () => {
    if (!pfxFile || !passphrase) return
    setUploading(true); setMsg(null)
    try {
      const s = await api.uploadSslPfx(pfxFile, passphrase)
      setStatus(s); setPfxFile(null); setPassphrase('')
      setMsg({ ok: true, text: 'Certificate installed from PFX. Restart the service (General tab) to enable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Upload failed' })
    } finally { setUploading(false) }
  }

  const remove = async () => {
    setRemoving(true); setMsg(null)
    try {
      await api.deleteSsl()
      setStatus({ installed: false })
      setMsg({ ok: true, text: 'Certificate removed. Restart service to disable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Remove failed' })
    } finally { setRemoving(false) }
  }

  const daysLeft = status?.days_until_expiry ?? 9999
  const expColor = daysLeft < 0 ? 'text-red-400' : daysLeft < 30 ? 'text-yellow-400' : 'text-green-400'
  const expBadge = daysLeft < 0 ? 'Expired' : daysLeft < 30 ? `Expires in ${daysLeft}d` : `Valid · ${daysLeft}d left`
  const pemReady = !!(certFile && keyFile)
  const pfxReady = !!(pfxFile && passphrase)

  return (
    <div className="space-y-4">
      {/* Enable HTTPS toggle — always visible */}
      <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
        <div>
          <p className="text-sm font-medium text-white">Enable HTTPS</p>
          <p className="text-xs text-gray-400">Requires a certificate · restart service to apply</p>
        </div>
        <button
          onClick={() => onToggleSSL(!sslEnabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${sslEnabled ? 'bg-blue-600' : 'bg-gray-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${sslEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {status?.installed ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></span>
              <span className="text-sm font-medium text-white">Certificate installed</span>
            </div>
            <span className={`text-xs font-medium ${expColor}`}>{expBadge}</span>
          </div>
          {status.subject && <p className="text-xs text-white font-mono">{status.subject}</p>}
          {status.issuer  && <p className="text-xs text-white">Issued by: {status.issuer}</p>}
          {status.expires && <p className="text-xs text-white">Expires: {status.expires}</p>}
          {status.error   && <p className="text-xs text-red-400">Warning: {status.error}</p>}
          <button onClick={remove} disabled={removing} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 pt-1">
            {removing ? 'Removing…' : '× Remove certificate'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-white">
          <span className="w-2 h-2 rounded-full bg-gray-600 flex-shrink-0"></span>
          No certificate installed · running HTTP
        </div>
      )}

      <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1 w-fit">
        <button onClick={() => setMode('pfx')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'pfx' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          PFX / P12
        </button>
        <button onClick={() => setMode('pem')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'pem' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          PEM (cert + key)
        </button>
      </div>

      {mode === 'pfx' ? (
        <div className="space-y-3">
          <SslDropZone label="PFX / P12 file (.pfx, .p12)" accept=".pfx,.p12"
            file={pfxFile} onFile={setPfxFile} dragging={pfxDrag} onDrag={setPfxDrag} />
          <div>
            <label className="block text-xs text-gray-400 mb-1">Passphrase</label>
            <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)}
              placeholder="PFX passphrase"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={uploadPfx} disabled={!pfxReady || uploading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors">
              {uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
            {!pfxReady && <span className="text-xs text-gray-500">{!pfxFile ? 'Drop a PFX file above' : 'Enter the passphrase'}</span>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-3">
            <SslDropZone label="Certificate (.crt / .pem)" accept=".crt,.pem,.cer"
              file={certFile} onFile={setCertFile} dragging={certDrag} onDrag={setCertDrag} />
            <SslDropZone label="Private Key (.key / .pem)" accept=".key,.pem"
              file={keyFile} onFile={setKeyFile} dragging={keyDrag} onDrag={setKeyDrag} />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={uploadPem} disabled={!pemReady || uploading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors">
              {uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
            {!pemReady && <span className="text-xs text-gray-500">Drop both cert and key files above</span>}
          </div>
        </div>
      )}

      {msg && <p className={`text-xs ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}
      <p className="text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 leading-relaxed">
        After uploading, restart the service from the <strong className="text-white">General</strong> tab.
      </p>
    </div>
  )
}


// ── Credentials tab ───────────────────────────────────────────────────────────

interface Credential {
  id: number; name: string; description: string; snmp_version: string
  community: string; security_name: string; security_level: string
  auth_protocol: string; auth_key_enc: string; priv_protocol: string; priv_key_enc: string
  created_at: string; updated_at: string
}

interface CredentialFormState {
  name: string; description: string; snmp_version: string; community: string
  security_name: string; security_level: string; auth_protocol: string
  auth_key: string; priv_protocol: string; priv_key: string
}

const EMPTY_CRED: CredentialFormState = {
  name: '', description: '', snmp_version: 'v2c', community: 'public',
  security_name: '', security_level: 'noAuthNoPriv', auth_protocol: 'SHA256',
  auth_key: '', priv_protocol: 'AES128', priv_key: '',
}

function CredentialFormModal({ cred, onClose, onSaved }: {
  cred: Credential | null; onClose: () => void; onSaved: () => void
}) {
  const editing = !!cred
  const [form, setForm] = useState<CredentialFormState>(
    editing ? {
      name: cred!.name, description: cred!.description,
      snmp_version: cred!.snmp_version, community: cred!.community,
      security_name: cred!.security_name, security_level: cred!.security_level,
      auth_protocol: cred!.auth_protocol, auth_key: '',
      priv_protocol: cred!.priv_protocol, priv_key: '',
    } : { ...EMPTY_CRED }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })
  const setF = (k: keyof CredentialFormState, v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const url = editing ? `/api/snmp/credentials/${cred!.id}` : '/api/snmp/credentials'
      const method = editing ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: authHeader(), body: JSON.stringify(form) })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{editing ? `Edit — ${cred!.name}` : 'Add Credential'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Name *</label>
              <input value={form.name} onChange={e => setF('name', e.target.value)} required placeholder="e.g. v2c-site1, v3-site2-authPriv"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">SNMP version</label>
              <select value={form.snmp_version} onChange={e => setF('snmp_version', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {['v1', 'v2c', 'v3'].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Description</label>
            <input value={form.description} onChange={e => setF('description', e.target.value)} placeholder="e.g. Site1 v2c read-only"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>

          {form.snmp_version !== 'v3' && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">Community string</label>
              <input value={form.community} onChange={e => setF('community', e.target.value)} placeholder="public"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          )}

          {form.snmp_version === 'v3' && (
            <div className="space-y-3 bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-300">SNMPv3 parameters</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Security name</label>
                  <input value={form.security_name} onChange={e => setF('security_name', e.target.value)}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Security level</label>
                  <select value={form.security_level} onChange={e => setF('security_level', e.target.value)}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                    {['noAuthNoPriv', 'authNoPriv', 'authPriv'].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                {['authNoPriv', 'authPriv'].includes(form.security_level) && (
                  <>
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Auth protocol</label>
                      <select value={form.auth_protocol} onChange={e => setF('auth_protocol', e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                        {['MD5', 'SHA', 'SHA256', 'SHA384', 'SHA512'].map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Auth key {editing ? '(leave blank to keep)' : '*'}</label>
                      <input type="password" value={form.auth_key} onChange={e => setF('auth_key', e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                  </>
                )}
                {form.security_level === 'authPriv' && (
                  <>
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Privacy protocol</label>
                      <select value={form.priv_protocol} onChange={e => setF('priv_protocol', e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                        {['DES', 'AES128', 'AES192', 'AES256'].map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Privacy key {editing ? '(leave blank to keep)' : '*'}</label>
                      <input type="password" value={form.priv_key} onChange={e => setF('priv_key', e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add Credential')}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function CredentialsTab() {
  const { user: me }                  = useAuth()
  const isAdmin                       = me?.role === 'admin'
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading]         = useState(true)
  const [modal, setModal]             = useState<Credential | null | 'new'>(null)
  const [confirm, setConfirm]         = useState<Credential | null>(null)
  const [error, setError]             = useState('')
  const [revealed, setRevealed]       = useState<Set<number>>(new Set())

  const toggleReveal = (id: number) =>
    setRevealed(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/snmp/credentials', { headers: authHeader() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCredentials(Array.isArray(data) ? data : [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const deleteCredential = async (c: Credential) => {
    try {
      const res = await fetch(`/api/snmp/credentials/${c.id}`, { method: 'DELETE', headers: authHeader() })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      setConfirm(null); await load()
    } catch (e: any) { setError(e.message) }
  }

  const versionBadge = (v: string) => {
    const map: Record<string, string> = {
      v1:  'bg-gray-700 text-gray-300',
      v2c: 'bg-blue-900/40 text-blue-300 border border-blue-700/40',
      v3:  'bg-purple-900/40 text-purple-300 border border-purple-700/40',
    }
    return map[v] ?? 'bg-gray-700 text-gray-300'
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">SNMP Credentials</h2>
            <HelpButton title="SNMP Credentials — How It Works">
              <p>A credential is a <span className="text-gray-300 font-medium">named, reusable auth set</span> (v1/v2c community string, or v3 user/auth/priv) — create it once here, then assign it to any number of devices in the Devices page instead of re-entering SNMP auth per device.</p>
              <p>Deleting a credential that's still assigned to a device will break polling for that device — reassign it to a different credential first.</p>
              <p><span className="text-gray-300 font-medium">v3</span> credentials carry actual auth/priv passphrases; only admins can reveal a saved credential's secret fields, matching how other secrets are gated elsewhere in the app.</p>
            </HelpButton>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">Named credential sets referenced by devices — manage all auth here, assign to devices in the Devices tab</p>
        </div>
        <button onClick={() => setModal('new')}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Add Credential
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Version</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden sm:table-cell">Details</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden md:table-cell">Description</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {credentials.map(c => (
                <tr key={c.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <p className="text-white font-medium text-sm">{c.name}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded font-mono ${versionBadge(c.snmp_version)}`}>{c.snmp_version}</span>
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden sm:table-cell font-mono">
                    {c.snmp_version !== 'v3' ? (
                      <span className="flex items-center gap-2">
                        <span>{revealed.has(c.id) ? c.community : '••••••••'}</span>
                        {isAdmin && (
                          <button onClick={() => toggleReveal(c.id)}
                            className="text-[10px] text-gray-500 hover:text-blue-400 transition-colors font-sans">
                            {revealed.has(c.id) ? 'hide' : 'view'}
                          </button>
                        )}
                      </span>
                    ) : `${c.security_name || '—'} / ${c.security_level}`}
                  </td>
                  <td className="px-5 py-3 text-gray-500 text-xs hidden md:table-cell">{c.description || '—'}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3 justify-end">
                      <button onClick={() => setModal(c)} className="text-xs text-gray-400 hover:text-blue-400 transition-colors">Edit</button>
                      <button onClick={() => setConfirm(c)} className="text-xs text-gray-400 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {credentials.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-500">No credentials defined</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {(modal === 'new' || (modal && typeof modal === 'object')) && (
        <CredentialFormModal
          cred={modal === 'new' ? null : modal as Credential}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load() }}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete credential?</h3>
            <p className="text-sm text-gray-300 mb-5">Remove <span className="text-white font-medium">{confirm.name}</span>? Any devices using it will lose their credential assignment.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
              <button onClick={() => deleteCredential(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Users tab ─────────────────────────────────────────────────────────────────
const ROLES = ['admin', 'viewer', 'analyst']

function badge(active: boolean) {
  return active
    ? 'bg-green-900/40 text-green-400 border border-green-700/40'
    : 'bg-gray-800 text-white border border-gray-700'
}

function roleBadge(role: string) {
  const map: Record<string, string> = {
    admin:   'bg-blue-900/40 text-blue-300 border border-blue-700/40',
    viewer:  'bg-gray-800 text-white border border-gray-700',
    analyst: 'bg-purple-900/40 text-purple-300 border border-purple-700/40',
  }
  return map[role] ?? 'bg-gray-800 text-white border border-gray-700'
}

interface UserModalProps { user?: User | null; onClose: () => void; onSaved: () => void }

function UserModal({ user, onClose, onSaved }: UserModalProps) {
  const editing = !!user
  const [form, setForm] = useState<UserIn>({
    username: user?.username ?? '',
    email:    user?.email ?? '',
    role:     user?.role ?? 'viewer',
    password: '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const setF = (k: keyof UserIn, v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing && !form.password) { setError('Password required for new users'); return }
    setSaving(true)
    try {
      const payload = { ...form, password: form.password || undefined }
      if (editing) await api.updateUser(user!.id, payload)
      else         await api.createUser(payload)
      onSaved()
    } catch (err: any) {
      setError(err.message ?? 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-5">{editing ? `Edit — ${user!.username}` : 'New User'}</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Username</label>
            <input value={form.username} onChange={e => setF('username', e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Email</label>
            <input type="email" value={form.email} onChange={e => setF('email', e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">
              Password {editing && <span className="text-white">(leave blank to keep current)</span>}
            </label>
            <input type="password" value={form.password} onChange={e => setF('password', e.target.value)}
              placeholder={editing ? '••••••••' : 'Required'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Role</label>
            <select value={form.role} onChange={e => setF('role', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Create User')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ResetPwProps { user: User; onClose: () => void }

function ResetPasswordModal({ user, onClose }: ResetPwProps) {
  const [pw, setPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pw.length < 6) { setErr('Password must be at least 6 characters'); return }
    if (pw !== confirmPw) { setErr('Passwords do not match'); return }
    setSaving(true)
    try {
      await api.resetUserPassword(user.id, pw)
      onClose()
    } catch (e: any) {
      setErr(e.message ?? 'Failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-1">Reset Password</h2>
        <p className="text-sm text-white mb-5">Set a new password for <span className="text-white font-medium">{user.username}</span></p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">New Password</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Confirm Password</label>
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Set Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Providers whose response the user can filter down to specific sections in
// the IP Lookup modal. Keyed by provider id; each entry's field keys match
// what the backend's IPINFO_FIELDS / IPAPI_IS_FIELDS constants accept.
const FIELD_SETS: Record<string, { key: string; label: string }[]> = {
  ipinfo: [
    { key: 'geolocation', label: 'Geolocation' },
    { key: 'asn',         label: 'ASN / Org' },
    { key: 'company',     label: 'Company' },
    { key: 'privacy',     label: 'Privacy Detection (VPN/Proxy/Tor)' },
    { key: 'abuse',       label: 'Abuse Contact' },
    { key: 'domains',     label: 'Hosted Domains' },
  ],
  ipapi_is: [
    { key: 'geolocation', label: 'Geolocation' },
    { key: 'asn',         label: 'ASN / Org' },
    { key: 'company',     label: 'Company' },
    { key: 'detection',   label: 'Threat Detection (VPN/Proxy/Tor/Datacenter)' },
    { key: 'abuse',       label: 'Abuse Contact' },
  ],
  mxtoolbox: [
    { key: 'ptr',       label: 'Reverse DNS (PTR)' },
    { key: 'asn',       label: 'ASN' },
    { key: 'blacklist', label: 'Blacklist Check' },
  ],
}
const setFieldsApi: Record<string, (fields: string[]) => Promise<UserApiKey>> = {
  ipinfo: api.setIpinfoFields,
  ipapi_is: api.setIpapiIsFields,
  mxtoolbox: api.setMxtoolboxFields,
}
// The 5 providers with a section in the IP Lookup modal — AbuseIPDB and
// IPQualityScore have no per-field checkboxes (single score, not multiple
// sections) but still get the modal-section on/off toggle.
const MODAL_PROVIDERS = ['ipinfo', 'ipapi_is', 'abuseipdb', 'mxtoolbox', 'ipqualityscore']

function ApiKeysTab({ lucidToken, onLucidChange, lucidSave }: {
  lucidToken: string
  onLucidChange: (v: string) => void
  lucidSave: { saving: boolean; saved: boolean; error: string; save: () => Promise<void> }
}) {
  const { user } = useAuth()
  const [keys, setKeys]       = useState<UserApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts]   = useState<Record<string, string>>({})
  const [saving, setSaving]   = useState<Record<string, boolean>>({})
  const [saved, setSaved]     = useState<Record<string, boolean>>({})
  const [error, setError]     = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [fieldsError, setFieldsError] = useState('')

  async function handleToggleField(provider: string, fieldKey: string, checked: boolean) {
    const providerKey = keys.find(k => k.provider === provider)
    const current = providerKey?.enabled_fields ?? FIELD_SETS[provider].map(f => f.key)
    const next = checked ? [...current, fieldKey] : current.filter(f => f !== fieldKey)
    setFieldsError('')
    try {
      const updated = await setFieldsApi[provider](next)
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message ?? 'Failed to save')
    }
  }

  async function handleToggleFreeTier(checked: boolean) {
    setFieldsError('')
    try {
      const updated = await api.setIpapiIsFreeTier(checked)
      setKeys(prev => prev.map(k => k.provider === 'ipapi_is' ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message ?? 'Failed to save')
    }
  }

  async function handleToggleEnabled(provider: string, checked: boolean) {
    setFieldsError('')
    try {
      const updated = await api.setProviderEnabled(provider, checked)
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message ?? 'Failed to save')
    }
  }

  function load() {
    setLoading(true)
    api.getUserApiKeys()
      .then(rows => { setKeys(rows); setDrafts(Object.fromEntries(rows.map(r => [r.provider, r.api_key]))) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  async function handleSave(provider: string) {
    setSaving(s => ({ ...s, [provider]: true }))
    setError(e => ({ ...e, [provider]: '' }))
    try {
      const updated = await api.setUserApiKey(provider, drafts[provider] ?? '')
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
      setSaved(s => ({ ...s, [provider]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [provider]: false })), 2000)
    } catch (err: any) {
      setError(e => ({ ...e, [provider]: err.message ?? 'Save failed' }))
    } finally {
      setSaving(s => ({ ...s, [provider]: false }))
    }
  }

  async function handleTest(provider: string) {
    setTesting(t => ({ ...t, [provider]: true }))
    setTestResult(r => ({ ...r, [provider]: undefined as any }))
    try {
      const res = await api.testUserApiKey(provider, drafts[provider] ?? '')
      setTestResult(r => ({ ...r, [provider]: { ok: res.status === 'ok', detail: res.detail } }))
    } catch (err: any) {
      setTestResult(r => ({ ...r, [provider]: { ok: false, detail: err.message ?? 'Test failed' } }))
    } finally {
      setTesting(t => ({ ...t, [provider]: false }))
    }
  }

  const inp = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono'

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">User Keys</h2>
        <HelpButton title="User Keys — How It Works">
          <p>External API keys for lookup tools (IP reputation, geolocation, etc.) are <span className="text-gray-300 font-medium">personal, not shared</span> — each user stores their own key here under their own account, and only that user's own requests use it. Nobody else, including admins, can see the key's value.</p>
          <p>Leave a field blank and save to clear a key.</p>
        </HelpButton>
      </div>
      <p className="text-sm text-white">
        Signed in as <span className="text-white font-medium">{user?.username}</span> — these keys apply to your account only.
      </p>

      {loading ? (
        <p className="text-sm text-white">Loading…</p>
      ) : (
        <div className="space-y-4 max-w-lg">
          {keys.map(k => {
            const isFreeTier = k.provider === 'ipapi_is' && k.free_tier
            return (
            <div key={k.provider} className="pb-4 border-b-2 border-gray-600 last:border-0 last:pb-0">
              <label className="block text-xs text-white mb-1">{k.label}</label>
              {MODAL_PROVIDERS.includes(k.provider) && (
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={k.enabled}
                    onChange={e => handleToggleEnabled(k.provider, e.target.checked)}
                    className="accent-blue-600"
                  />
                  Show this provider in the IP Lookup modal
                </label>
              )}
              {k.provider === 'ipapi_is' && (
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={k.free_tier}
                    onChange={e => handleToggleFreeTier(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Use free tier (no key required, ~1,000 lookups/day)
                </label>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={drafts[k.provider] ?? ''}
                  onChange={e => setDrafts(d => ({ ...d, [k.provider]: e.target.value }))}
                  placeholder="Not set"
                  disabled={isFreeTier}
                  className={`${inp} ${isFreeTier ? 'opacity-40 cursor-not-allowed' : ''}`}
                />
                <button
                  onClick={() => handleTest(k.provider)}
                  disabled={isFreeTier || testing[k.provider] || !(drafts[k.provider] ?? '').trim()}
                  className="shrink-0 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
                >
                  {testing[k.provider] ? 'Testing…' : 'Test'}
                </button>
                <button
                  onClick={() => handleSave(k.provider)}
                  disabled={isFreeTier || saving[k.provider]}
                  className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {saving[k.provider] ? 'Saving…' : 'Save'}
                </button>
              </div>
              {saved[k.provider] && <p className="text-xs text-green-400 mt-1">Saved</p>}
              {error[k.provider] && <p className="text-xs text-red-400 mt-1">{error[k.provider]}</p>}
              {testResult[k.provider] && (
                <p className={`text-xs mt-1 ${testResult[k.provider].ok ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult[k.provider].ok ? '✓ ' : '✗ '}{testResult[k.provider].detail}
                </p>
              )}
              {FIELD_SETS[k.provider] && (
                <div className="mt-3 pl-1">
                  <p className="text-xs text-gray-500 mb-1.5">Shown in the IP Lookup modal:</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {FIELD_SETS[k.provider].map(f => (
                      <label key={f.key} className="flex items-center gap-2 text-xs text-white cursor-pointer">
                        <input
                          type="checkbox"
                          checked={k.enabled_fields ? k.enabled_fields.includes(f.key) : true}
                          onChange={e => handleToggleField(k.provider, f.key, e.target.checked)}
                          className="accent-blue-600"
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  {fieldsError && <p className="text-xs text-red-400 mt-1">{fieldsError}</p>}
                </div>
              )}
            </div>
          )})}
        </div>
      )}

      <div className="pt-2 border-t border-gray-800 max-w-lg">
        <p className="text-xs font-semibold text-white uppercase tracking-wider mt-4 mb-1">Lucidchart</p>
        <label className="block text-xs text-white mb-1">API token</label>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={lucidToken}
            onChange={e => onLucidChange(e.target.value)}
            placeholder="eyJ…"
            className={inp}
          />
          <button
            onClick={lucidSave.save}
            disabled={lucidSave.saving}
            className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            {lucidSave.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {lucidSave.saved && <p className="text-xs text-green-400 mt-1">Saved</p>}
        {lucidSave.error && <p className="text-xs text-red-400 mt-1">{lucidSave.error}</p>}
        <p className="text-xs text-gray-500 mt-1">Personal Access Token from lucid.co → Account → API Tokens. Required for topology export to Lucidchart.</p>
      </div>
    </div>
  )
}

function UsersTab() {
  const { user: me } = useAuth()
  const [users, setUsers]   = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]   = useState<'create' | User | null>(null)
  const [confirm, setConfirm] = useState<User | null>(null)
  const [resetPw, setResetPw] = useState<User | null>(null)
  const [error, setError]   = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [userSortKey, setUserSortKey] = useState<keyof User | null>(null)
  const [userSortDir, setUserSortDir] = useState<'asc' | 'desc'>('asc')

  const toggleUserSort = (key: keyof User) => {
    if (userSortKey === key) setUserSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setUserSortKey(key); setUserSortDir('asc') }
  }

  const load = () => {
    setLoading(true)
    api.getUsers().then(setUsers).catch(e => setError(e.message)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const toggle = async (u: User) => {
    try {
      if (u.is_active) await api.deactivateUser(u.id)
      else             await api.activateUser(u.id)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const del = async (u: User) => {
    try {
      await api.deleteUser(u.id)
      setConfirm(null)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const makeDefaultAdmin = async (u: User) => {
    try {
      await api.setDefaultAdmin(u.id)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const displayedUsers = users
    .filter(u => {
      if (!userFilter) return true
      const q = userFilter.toLowerCase()
      return u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      if (!userSortKey) return 0
      const av = a[userSortKey] as any
      const bv = b[userSortKey] as any
      if (typeof av === 'boolean') return userSortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av)
      if (typeof av === 'number') return userSortDir === 'asc' ? av - bv : bv - av
      return userSortDir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : String(bv ?? '').localeCompare(String(av ?? ''))
    })

  const SortTh = ({ label, col }: { label: string; col: keyof User }) => (
    <th
      onClick={() => toggleUserSort(col)}
      className="px-5 py-3 text-left text-xs font-medium text-white cursor-pointer select-none hover:text-white"
    >
      {label} {userSortKey === col ? (userSortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  const fmtRelative = (ts: string | null) => {
    if (!ts) return '—'
    // Timestamps come back as naive UTC (no 'Z'/offset) — without forcing UTC
    // interpretation here, the browser parses them as local time, which can
    // put the parsed time in the "future" relative to now and show as negative.
    const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
    return new Date(utc).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-white">Users</p>
        <HelpButton title="Users — How It Works">
          <p>Three roles: <span className="text-gray-300 font-medium">admin</span> (full access, including this Users tab, Credentials, and Hierarchy), <span className="text-gray-300 font-medium">analyst</span> (read access plus export), and <span className="text-gray-300 font-medium">viewer</span> (read-only, no export).</p>
          <p>This tab only manages <span className="text-gray-300 font-medium">local accounts</span> — SAML/Okta SSO users are auto-provisioned on first login and managed in Okta itself, not here.</p>
          <p><span className="text-gray-300 font-medium">Deactivate</span> blocks login immediately without deleting the account or its history — prefer it over Delete for someone leaving temporarily, since Delete is permanent.</p>
          <p>The <span className="text-yellow-400">★</span> marks the <span className="text-gray-300 font-medium">default admin</span> — when every auth method in the Auth tab is disabled, the app skips the login page entirely and signs everyone in as this account. Click the star on any active admin to reassign it.</p>
        </HelpButton>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <p className="text-xs text-gray-500">Local accounts only — Okta SSO users are managed in Okta</p>
        <div className="flex items-center gap-2 ml-auto">
          <input value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter users…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 w-40 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          {userFilter && <button onClick={() => setUserFilter('')} className="text-xs text-white hover:text-white">✕</button>}
          <button onClick={() => setModal('create')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
            <span className="text-base leading-none">+</span> Add User
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <SortTh label="User"       col="username" />
                <SortTh label="Email"      col="email" />
                <SortTh label="Role"       col="role" />
                <SortTh label="Status"     col="is_active" />
                <SortTh label="Last Login" col="last_login" />
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {displayedUsers.map(u => (
                <tr key={u.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-blue-600/30 flex items-center justify-center text-xs font-bold text-blue-300">
                        {u.username[0].toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-white text-sm font-medium">{u.username}</p>
                          <button
                            onClick={() => !u.is_default_admin && u.role === 'admin' && u.is_active && makeDefaultAdmin(u)}
                            disabled={u.is_default_admin || u.role !== 'admin' || !u.is_active}
                            title={u.is_default_admin
                              ? 'Default admin — auto-logged-in when all auth methods are disabled'
                              : (u.role === 'admin' && u.is_active ? 'Make default admin' : 'Only active admins can be the default admin')}
                            className={`text-sm leading-none ${u.is_default_admin ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300 disabled:hover:text-gray-500'}`}
                          >
                            {u.is_default_admin ? '★' : '☆'}
                          </button>
                        </div>
                        <p className="text-xs text-gray-500">{u.auth_provider === 'saml' ? 'SSO' : 'local'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-white text-sm">{u.email}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${roleBadge(u.role)}`}>{u.role}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${badge(u.is_active)}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-white text-sm">{fmtRelative(u.last_login)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3 justify-end">
                      <button onClick={() => setModal(u)} className="text-xs text-white hover:text-blue-400 transition-colors">Edit</button>
                      {u.auth_provider !== 'saml' && (
                        <button onClick={() => setResetPw(u)} className="text-xs text-white hover:text-amber-400 transition-colors">Reset PW</button>
                      )}
                      <button onClick={() => toggle(u)} className={`text-xs transition-colors ${u.is_active ? 'text-white hover:text-yellow-400' : 'text-white hover:text-green-400'}`}>
                        {u.is_active ? 'Disable' : 'Enable'}
                      </button>
                      {me?.username !== u.username && (
                        <button onClick={() => setConfirm(u)} className="text-xs text-white hover:text-red-400 transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {displayedUsers.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-white">No users found</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {(modal === 'create' || (modal && typeof modal === 'object')) && (
        <UserModal
          user={modal === 'create' ? null : modal as User}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete user?</h3>
            <p className="text-sm text-white mb-5">This will permanently delete <span className="text-white font-medium">{confirm.username}</span>.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-white hover:text-white">Cancel</button>
              <button onClick={() => del(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
      {resetPw && <ResetPasswordModal user={resetPw} onClose={() => setResetPw(null)} />}
    </div>
  )
}

// ── Hierarchy tab ─────────────────────────────────────────────────────────────

function HierarchyTab() {
  const [orgs, setOrgs]     = useState<HierarchyOrg[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  // Add-form state
  const [newOrg, setNewOrg]           = useState('')
  const [newGroup, setNewGroup]       = useState<Record<number, string>>({})   // orgId → name
  const [newSite, setNewSite]         = useState<Record<number, string>>({})   // groupId → name
  const [newLocation, setNewLocation] = useState<Record<number, string>>({})   // siteId → name
  const [addingOrg, setAddingOrg]     = useState(false)
  const [addingGroup, setAddingGroup] = useState<Record<number, boolean>>({})
  const [addingSite, setAddingSite]   = useState<Record<number, boolean>>({})
  const [addingLocation, setAddingLocation] = useState<Record<number, boolean>>({})

  // Expand/collapse
  const [expandedOrgs, setExpandedOrgs]     = useState<Set<number>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set())
  const [expandedSites, setExpandedSites]   = useState<Set<number>>(new Set())

  // Inline rename state — one edit at a time across all levels
  type HierarchyLevel = 'org' | 'group' | 'site' | 'location'
  const [editing, setEditing] = useState<{ level: HierarchyLevel; id: number; name: string } | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const startEdit = (level: HierarchyLevel, id: number, name: string) => setEditing({ level, id, name })
  const cancelEdit = () => setEditing(null)
  const saveEdit = async () => {
    if (!editing) return
    const name = editing.name.trim()
    if (!name) return
    setSavingEdit(true)
    try {
      if (editing.level === 'org') await api.updateHierarchyOrg(editing.id, name)
      else if (editing.level === 'group') await api.updateHierarchyGroup(editing.id, name)
      else if (editing.level === 'site') await api.updateHierarchySite(editing.id, name)
      else await api.updateHierarchyLocation(editing.id, name)
      setEditing(null)
      setOrgs(await api.getHierarchy())
    } catch (e: any) { setError(e.message || 'Failed') }
    finally { setSavingEdit(false) }
  }

  // Renders either the editable name span (with a small ✎ rename button) or,
  // while that exact row is being edited, an inline input + save/cancel.
  const renderName = (level: HierarchyLevel, id: number, name: string, displayCls: string) => {
    if (editing?.level === level && editing.id === id) {
      return (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <input
            autoFocus
            value={editing.name}
            onChange={e => setEditing(s => s && ({ ...s, name: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }}
            className="flex-1 min-w-0 bg-gray-800 border border-blue-600 rounded px-2 py-0.5 text-sm text-white focus:outline-none"
          />
          <button onClick={saveEdit} disabled={savingEdit || !editing.name.trim()} className="text-xs text-green-500 hover:text-green-400 disabled:opacity-40 px-1" title="Save">
            ✓
          </button>
          <button onClick={cancelEdit} className="text-xs text-gray-500 hover:text-gray-300 px-1" title="Cancel">
            ✕
          </button>
        </div>
      )
    }
    return (
      <span className={`${displayCls} flex-1 flex items-center gap-1.5`}>
        {name}
        <button onClick={() => startEdit(level, id, name)} className="text-gray-400 hover:text-blue-400 transition-colors text-xs" title="Rename">
          ✎
        </button>
      </span>
    )
  }

  const load = async () => {
    setLoading(true)
    try { setOrgs(await api.getHierarchy()) }
    catch (e: any) { setError(e.message || 'Failed to load hierarchy') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const toggleOrg   = (id: number) => setExpandedOrgs(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleGroup = (id: number) => setExpandedGroups(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSite  = (id: number) => setExpandedSites(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const addOrg = async () => {
    const name = newOrg.trim()
    if (!name) return
    setAddingOrg(true)
    try {
      await api.createHierarchyOrg(name)
      setNewOrg('')
      const updated = await api.getHierarchy()
      setOrgs(updated)
      const newEntry = updated.find(o => o.name === name)
      if (newEntry) setExpandedOrgs(s => new Set([...s, newEntry.id]))
    } catch (e: any) { setError(e.message || 'Failed') }
    finally { setAddingOrg(false) }
  }

  const deleteOrg = async (id: number, name: string) => {
    if (!window.confirm(`Delete org "${name}" and all its groups, sites, and locations?`)) return
    try { await api.deleteHierarchyOrg(id); setOrgs(await api.getHierarchy()) }
    catch (e: any) { setError(e.message || 'Failed') }
  }

  const addGroup = async (orgId: number) => {
    const name = (newGroup[orgId] ?? '').trim()
    if (!name) return
    setAddingGroup(s => ({ ...s, [orgId]: true }))
    try {
      const grp = await api.createHierarchyGroup(name, orgId)
      setNewGroup(s => ({ ...s, [orgId]: '' }))
      const updated = await api.getHierarchy()
      setOrgs(updated)
      setExpandedOrgs(s => new Set([...s, orgId]))
      setExpandedGroups(s => new Set([...s, grp.id]))
    } catch (e: any) { setError(e.message || 'Failed') }
    finally { setAddingGroup(s => ({ ...s, [orgId]: false })) }
  }

  const deleteGroup = async (id: number, name: string) => {
    if (!window.confirm(`Delete group "${name}" and all its sites and locations?`)) return
    try { await api.deleteHierarchyGroup(id); setOrgs(await api.getHierarchy()) }
    catch (e: any) { setError(e.message || 'Failed') }
  }

  const addSite = async (groupId: number) => {
    const name = (newSite[groupId] ?? '').trim()
    if (!name) return
    setAddingSite(s => ({ ...s, [groupId]: true }))
    try {
      const site = await api.createHierarchySite(name, groupId)
      setNewSite(s => ({ ...s, [groupId]: '' }))
      setOrgs(await api.getHierarchy())
      setExpandedGroups(s => new Set([...s, groupId]))
      setExpandedSites(s => new Set([...s, site.id]))
    } catch (e: any) { setError(e.message || 'Failed') }
    finally { setAddingSite(s => ({ ...s, [groupId]: false })) }
  }

  const deleteSite = async (id: number, name: string) => {
    if (!window.confirm(`Delete site "${name}" and all its locations?`)) return
    try { await api.deleteHierarchySite(id); setOrgs(await api.getHierarchy()) }
    catch (e: any) { setError(e.message || 'Failed') }
  }

  const addLocation = async (siteId: number) => {
    const name = (newLocation[siteId] ?? '').trim()
    if (!name) return
    setAddingLocation(s => ({ ...s, [siteId]: true }))
    try {
      await api.createHierarchyLocation(name, siteId)
      setNewLocation(s => ({ ...s, [siteId]: '' }))
      setOrgs(await api.getHierarchy())
      setExpandedSites(s => new Set([...s, siteId]))
    } catch (e: any) { setError(e.message || 'Failed') }
    finally { setAddingLocation(s => ({ ...s, [siteId]: false })) }
  }

  const deleteLocation = async (id: number, name: string) => {
    if (!window.confirm(`Delete location "${name}"?`)) return
    try { await api.deleteHierarchyLocation(id); setOrgs(await api.getHierarchy()) }
    catch (e: any) { setError(e.message || 'Failed') }
  }

  if (loading) return <div className="flex items-center justify-center h-32 text-white text-sm">Loading hierarchy…</div>

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-xl px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-red-400">{error}</p>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-300 text-lg leading-none">✕</button>
        </div>
      )}

      {/* Description card */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-sm font-semibold text-white">Org / Group / Site / Location Hierarchy</h2>
          <HelpButton title="Hierarchy — How It Works">
            <p>Four fixed levels — <span className="text-gray-300 font-medium">Org → Group → Site → Location</span> — that populate the cascading dropdowns used when placing a device (Devices page) and on the Dashboard's environment tree. There's no fifth level and no reordering; only the names at each level are yours to define.</p>
            <p><span className="text-amber-500 font-medium">Deletes cascade with no separate confirmation per level</span> — removing an Org deletes every Group, Site, and Location beneath it in one action. If a device's saved placement no longer matches any entry here (renamed or deleted after the device was set up), the Devices edit form still shows the old value as a selectable option rather than silently dropping it.</p>
            <p>Renaming a level in place (the pencil icon) doesn't require re-saving every device — it's the same row, just relabeled.</p>
          </HelpButton>
        </div>
        <p className="text-xs text-gray-400">
          Define the organization tree that appears as dropdowns in device configuration.
          Structure: <span className="text-white font-medium">Org → Group → Site → Location</span>.
          Deleting an entry cascades — removing an Org deletes all its Groups, Sites, and Locations.
        </p>
      </div>

      {/* Add org row */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
        <p className="text-xs font-semibold text-white uppercase tracking-wider mb-3">Add Organization</p>
        <div className="flex items-center gap-2">
          <input
            value={newOrg}
            onChange={e => setNewOrg(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addOrg()}
            placeholder="New org name…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={addOrg}
            disabled={addingOrg || !newOrg.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
          >
            {addingOrg ? 'Adding…' : '+ Add Org'}
          </button>
        </div>
      </div>

      {/* Org tree */}
      {orgs.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-8 text-center">
          <p className="text-sm text-gray-500">No organizations defined yet. Add one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {orgs.map(org => (
            <div key={org.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {/* Org row */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
                <button onClick={() => toggleOrg(org.id)} className="text-gray-400 hover:text-white transition-colors w-4 flex-shrink-0 text-xs">
                  {expandedOrgs.has(org.id) ? '▼' : '▶'}
                </button>
                <svg className="w-4 h-4 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
                {renderName('org', org.id, org.name, 'text-sm font-medium text-white')}
                <span className="text-xs text-gray-500">{org.groups.length} group{org.groups.length !== 1 ? 's' : ''}</span>
                <button
                  onClick={() => deleteOrg(org.id, org.name)}
                  className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded transition-colors ml-1"
                  title="Delete org"
                >
                  Delete
                </button>
              </div>

              {expandedOrgs.has(org.id) && (
                <div className="px-4 py-3 space-y-3">
                  {/* Add group row */}
                  <div className="flex items-center gap-2 pl-6">
                    <input
                      value={newGroup[org.id] ?? ''}
                      onChange={e => setNewGroup(s => ({ ...s, [org.id]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && addGroup(org.id)}
                      placeholder="New group name…"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => addGroup(org.id)}
                      disabled={addingGroup[org.id] || !(newGroup[org.id] ?? '').trim()}
                      className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
                    >
                      {addingGroup[org.id] ? 'Adding…' : '+ Group'}
                    </button>
                  </div>

                  {/* Group list */}
                  {org.groups.length === 0 ? (
                    <p className="text-xs text-gray-600 pl-6">No groups yet.</p>
                  ) : (
                    <div className="space-y-2 pl-4">
                      {org.groups.map(grp => (
                        <div key={grp.id} className="bg-gray-800/50 border border-gray-700/50 rounded-lg overflow-hidden">
                          {/* Group row */}
                          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/50">
                            <button onClick={() => toggleGroup(grp.id)} className="text-gray-500 hover:text-white transition-colors w-3 flex-shrink-0 text-xs">
                              {expandedGroups.has(grp.id) ? '▼' : '▶'}
                            </button>
                            <svg className="w-3.5 h-3.5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            {renderName('group', grp.id, grp.name, 'text-sm text-white')}
                            <span className="text-xs text-gray-500">{grp.sites.length} site{grp.sites.length !== 1 ? 's' : ''}</span>
                            <button
                              onClick={() => deleteGroup(grp.id, grp.name)}
                              className="text-xs text-red-500 hover:text-red-400 px-2 py-0.5 rounded transition-colors ml-1"
                              title="Delete group"
                            >
                              Delete
                            </button>
                          </div>

                          {expandedGroups.has(grp.id) && (
                            <div className="px-3 py-2.5 space-y-2">
                              {/* Add site row */}
                              <div className="flex items-center gap-2 pl-5">
                                <input
                                  value={newSite[grp.id] ?? ''}
                                  onChange={e => setNewSite(s => ({ ...s, [grp.id]: e.target.value }))}
                                  onKeyDown={e => e.key === 'Enter' && addSite(grp.id)}
                                  placeholder="New site name…"
                                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <button
                                  onClick={() => addSite(grp.id)}
                                  disabled={addingSite[grp.id] || !(newSite[grp.id] ?? '').trim()}
                                  className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
                                >
                                  {addingSite[grp.id] ? 'Adding…' : '+ Site'}
                                </button>
                              </div>

                              {/* Site list */}
                              {grp.sites.length === 0 ? (
                                <p className="text-xs text-gray-600 pl-5">No sites yet.</p>
                              ) : (
                                <div className="space-y-2 pl-5">
                                  {grp.sites.map((site: HierarchySite) => (
                                    <div key={site.id} className="bg-gray-800/40 border border-gray-700/40 rounded-lg overflow-hidden">
                                      {/* Site row */}
                                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-700/40">
                                        <button onClick={() => toggleSite(site.id)} className="text-gray-600 hover:text-white transition-colors w-3 flex-shrink-0 text-xs">
                                          {expandedSites.has(site.id) ? '▼' : '▶'}
                                        </button>
                                        <svg className="w-3 h-3 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                          <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                                        </svg>
                                        {renderName('site', site.id, site.name, 'text-xs text-gray-300')}
                                        <span className="text-xs text-gray-600">{site.locations.length} location{site.locations.length !== 1 ? 's' : ''}</span>
                                        <button
                                          onClick={() => deleteSite(site.id, site.name)}
                                          className="text-xs text-red-500 hover:text-red-400 px-1.5 py-0.5 rounded transition-colors"
                                          title="Delete site"
                                        >
                                          ✕
                                        </button>
                                      </div>

                                      {expandedSites.has(site.id) && (
                                        <div className="px-2.5 py-2 space-y-1.5">
                                          {/* Add location row */}
                                          <div className="flex items-center gap-2 pl-4">
                                            <input
                                              value={newLocation[site.id] ?? ''}
                                              onChange={e => setNewLocation(s => ({ ...s, [site.id]: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && addLocation(site.id)}
                                              placeholder="New location name…"
                                              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            />
                                            <button
                                              onClick={() => addLocation(site.id)}
                                              disabled={addingLocation[site.id] || !(newLocation[site.id] ?? '').trim()}
                                              className="px-2.5 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
                                            >
                                              {addingLocation[site.id] ? 'Adding…' : '+ Location'}
                                            </button>
                                          </div>

                                          {/* Location list */}
                                          {site.locations.length === 0 ? (
                                            <p className="text-xs text-gray-600 pl-4">No locations yet.</p>
                                          ) : (
                                            <div className="space-y-1 pl-4">
                                              {site.locations.map((loc: HierarchyLocation) => (
                                                <div key={loc.id} className="flex items-center gap-2 py-1">
                                                  <svg className="w-3 h-3 text-purple-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                                                  </svg>
                                                  {renderName('location', loc.id, loc.name, 'text-xs text-gray-300')}
                                                  <button
                                                    onClick={() => deleteLocation(loc.id, loc.name)}
                                                    className="text-xs text-red-500 hover:text-red-400 px-1.5 py-0.5 rounded transition-colors"
                                                    title="Delete location"
                                                  >
                                                    ✕
                                                  </button>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
