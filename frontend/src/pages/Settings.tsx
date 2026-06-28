import { Component, useEffect, useRef, useState } from 'react'
import { api, getToken, User, UserIn, SslStatus } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import { useAuth } from '../store/auth'

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

// ── Section wrapper with Save ─────────────────────────────────────────────────
function Section({
  title, children, onSave, saving, saved, error,
}: {
  title: string
  children: React.ReactNode
  onSave: () => Promise<void>
  saving: boolean
  saved: boolean
  error: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
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
type TabId = 'general' | 'snmp' | 'credentials' | 'storage' | 'backup' | 'auth' | 'notifications' | 'integrations' | 'users'

const TABS: Array<{ id: TabId; label: string; adminOnly?: boolean }> = [
  { id: 'general',       label: 'General' },
  { id: 'snmp',          label: 'SNMP' },
  { id: 'credentials',   label: 'Credentials' },
  { id: 'storage',       label: 'Storage' },
  { id: 'backup',        label: 'Backup' },
  { id: 'auth',          label: 'Auth' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'integrations',  label: 'Integrations' },
  { id: 'users',         label: 'Users', adminOnly: true },
]

export default function Settings() {
  const { user: me }          = useAuth()
  const isAdmin               = me?.role === 'admin'
  const [tab, setTab]         = useState<TabId>('general')
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const dirtyRef = useRef(false)

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

  const generalSave = useSave(['app_name', 'base_url', 'timezone', 'anthropic_api_key', 'ai_model'], settings, load)
  const snmpSave = useSave([
    'snmp_trap_enabled', 'snmp_trap_port', 'snmp_poll_enabled', 'snmp_poll_interval_seconds',
  ], settings, load)
  const storageSave = useSave([
    'storage_backend', 'retention_days_raw', 'retention_days_hourly', 'alert_event_retention_days',
  ], settings, load)
  const backupSave = useSave([
    'backup_enabled', 'backup_interval_hours', 'backup_rotation_count', 'backup_path', 'backup_include_clickhouse',
  ], settings, load)
  const authSave = useSave([
    'auth_local_enabled', 'session_timeout_minutes',
    'okta_saml_enabled', 'okta_saml_idp_entity_id', 'okta_saml_idp_sso_url',
    'okta_saml_idp_cert', 'okta_saml_sp_entity_id', 'okta_saml_sp_cert', 'okta_saml_sp_key',
  ], settings, load)
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
  const integrationsSave = useSave(
    ['lucid_api_token', 'ssl_enabled', 'ssl_certfile', 'ssl_keyfile'],
    settings, load
  )

  const [testConnRunning, setTestConnRunning] = useState(false)
  const [testConnResult, setTestConnResult]   = useState<{ ok: boolean; message: string } | null>(null)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupResult, setCleanupResult]   = useState<string | null>(null)
  const [exportRunning, setExportRunning]   = useState(false)
  const [exportError, setExportError]       = useState<string | null>(null)
  const [importFile, setImportFile]         = useState<File | null>(null)
  const [importRunning, setImportRunning]   = useState(false)
  const [importResult, setImportResult]     = useState<Record<string, string> | null>(null)
  const [importError, setImportError]       = useState<string | null>(null)
  const [backupRunning, setBackupRunning]   = useState(false)
  const [backupResult, setBackupResult]     = useState<string | null>(null)
  const [backups, setBackups]               = useState<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>([])
  const [backupsLoaded, setBackupsLoaded]   = useState(false)

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
      const result = await api.importBundle(importFile)
      setImportResult(result)
    } catch (e: any) {
      setImportError(e.message || 'Import failed')
    } finally { setImportRunning(false) }
  }

  const runExport = async () => {
    setExportRunning(true)
    setExportError(null)
    try {
      const { blob, filename } = await api.exportConfig()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
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
      <h1 className="text-xl font-bold text-white">Settings</h1>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit overflow-x-auto">
        {TABS.filter(t => !t.adminOnly || isAdmin).map(t => (
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

      {/* General */}
      {tab === 'general' && (
        <Section title="General" onSave={generalSave.save} saving={generalSave.saving} saved={generalSave.saved} error={generalSave.error}>
          <Field label="App name" hint="Displayed in browser tab and header">
            <TextInput value={str('app_name', 'pktSNMP')} onChange={v => set('app_name', v)} />
          </Field>
          <Field label="Base URL" hint="Used for redirect URIs and notification links">
            <TextInput value={str('base_url')} onChange={v => set('base_url', v)} placeholder="http://SERVER-IP:8767" />
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

          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">AI Assistant (Claude)</p>
          </div>
          <Field label="Anthropic API key" hint="Required for the in-app AI assistant. Get a key at console.anthropic.com.">
            <TextInput value={str('anthropic_api_key')} onChange={v => set('anthropic_api_key', v)} placeholder="sk-ant-…" secret mono />
          </Field>
          <Field label="AI model" hint="Model used for the assistant. Haiku is fast and cost-effective.">
            <SelectInput
              value={str('ai_model', 'claude-haiku-4-5-20251001')}
              onChange={v => set('ai_model', v)}
              options={[
                { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, low cost)' },
                { value: 'claude-sonnet-4-6', label: 'Claude Sonnet (balanced)' },
                { value: 'claude-opus-4-8', label: 'Claude Opus (most capable)' },
              ]}
            />
          </Field>
          <RestartServiceRow />
        </Section>
      )}

      {/* SNMP */}
      {tab === 'snmp' && (
        <Section title="SNMP" onSave={snmpSave.save} saving={snmpSave.saving} saved={snmpSave.saved} error={snmpSave.error}>
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

          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Polling Engine</p>
          </div>
          <Field label="Enable polling" hint="Actively poll registered devices for OID values">
            <Toggle value={bool('snmp_poll_enabled')} onChange={v => set('snmp_poll_enabled', v)} />
          </Field>
          {bool('snmp_poll_enabled') && (
            <Field label="Poll interval" hint="Seconds between poll cycles">
              <div className="flex items-center gap-3">
                <NumberInput value={num('snmp_poll_interval_seconds', 300)} onChange={v => set('snmp_poll_interval_seconds', v)} min={10} max={86400} />
                <span className="text-sm text-white">seconds</span>
              </div>
            </Field>
          )}

          <div className="py-4">
            <p className="text-xs text-blue-400 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
              Trap receiver and local polling engine settings. Remote collectors (otelcol) are managed under Collectors in the left nav. Changes take effect after a service restart.
            </p>
          </div>
        </Section>
      )}

      {/* Credentials */}
      {tab === 'credentials' && <TabErrorBoundary><CredentialsTab /></TabErrorBoundary>}

      {/* Storage */}
      {tab === 'storage' && (
        <Section title="Storage" onSave={storageSave.save} saving={storageSave.saving} saved={storageSave.saved} error={storageSave.error}>
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
      {tab === 'backup' && (
        <Section title="Backup" onSave={backupSave.save} saving={backupSave.saving} saved={backupSave.saved} error={backupSave.error}>
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
            <TextInput value={str('backup_path', '/mnt/software/pktsnmp_backups')} onChange={v => set('backup_path', v)} mono />
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
                    <div key={b.name} className="flex items-center gap-3 text-xs text-white">
                      <span className="font-mono">{b.name}</span>
                      <span className="text-white">{(b.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
                      <span className="text-white">{b.files.join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field label="Export bundle" hint="Download pktsnmp.db + config.yaml + ClickHouse SNMP data as a .tar.gz">
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={runExport} disabled={exportRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                {exportRunning ? 'Generating…' : 'Download Export'}
              </button>
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
                <button onClick={runImport} disabled={!importFile || importRunning}
                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors">
                  {importRunning ? 'Restoring…' : 'Restore'}
                </button>
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

      {/* Auth */}
      {tab === 'auth' && (
        <Section title="Authentication" onSave={authSave.save} saving={authSave.saving} saved={authSave.saved} error={authSave.error}>
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

      {/* Notifications */}
      {tab === 'notifications' && (
        <Section title="Notifications" onSave={notifySave.save} saving={notifySave.saving} saved={notifySave.saved} error={notifySave.error}>
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

      {/* Users tab — admin only */}
      {tab === 'users' && isAdmin && <UsersTab />}

      {/* Integrations */}
      {tab === 'integrations' && (
        <Section title="Integrations" onSave={integrationsSave.save} saving={integrationsSave.saving} saved={integrationsSave.saved} error={integrationsSave.error}>
          <div className="pt-2 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Lucidchart</p>
          </div>
          <Field label="API token" hint="Personal Access Token from lucid.co → Account → API Tokens.">
            <TextInput value={str('lucid_api_token')} onChange={v => set('lucid_api_token', v)} placeholder="eyJ…" secret mono />
          </Field>
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">SSL / TLS</p>
          </div>
          <div className="py-3">
            <SslPanel />
          </div>
        </Section>
      )}
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

function SslPanel() {
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
              <input value={form.name} onChange={e => setF('name', e.target.value)} required placeholder="SiteA-v2c"
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
            <input value={form.description} onChange={e => setF('description', e.target.value)} placeholder="e.g. Medical v2c read-only"
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
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading]         = useState(true)
  const [modal, setModal]             = useState<Credential | null | 'new'>(null)
  const [confirm, setConfirm]         = useState<Credential | null>(null)
  const [error, setError]             = useState('')

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
          <h2 className="text-sm font-semibold text-white">SNMP Credentials</h2>
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
                    {c.snmp_version !== 'v3' ? c.community : `${c.security_name || '—'} / ${c.security_level}`}
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
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  return (
    <div className="space-y-4">
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
                        <p className="text-white text-sm font-medium">{u.username}</p>
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
