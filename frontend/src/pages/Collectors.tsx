/**
 * Collectors.tsx — Remote otelcol collector management.
 *
 * Admin-only actions: SSH config, Sync, Preview config, Test SSH.
 * All users can view collector status and sync state.
 */
import { useEffect, useRef, useState } from 'react'
import { getToken, api, IngestRateBucket } from '../api/client'

interface Collector {
  id: number
  name: string
  description: string
  ip: string | null
  last_seen: string | null
  status: string
  version: string | null
  created_at: string
  // SSH config (secrets are masked as "••••••••" if set)
  ssh_host: string | null
  ssh_port: number | null
  ssh_user: string | null
  ssh_auth_type: string | null
  ssh_key_enc: string | null       // "••••••••" if set, null if not
  ssh_password_enc: string | null  // "••••••••" if set, null if not
  otelcol_config_path: string | null
  otelcol_service: string | null
  // Sync state
  sync_status: string | null       // 'synced' | 'error' | 'unknown' | null
  last_synced_at: string | null
  last_sync_error: string | null
  // Health / 3-state status (derived server-side)
  effective_status: string          // 'online' | 'offline' | 'error'
  auth_failure_count: number
  last_auth_failure_at: string | null
}

// ── helpers ───────────────────────────────────────────────────────────────────

const fmtRelative = (ts: string | null) => {
  if (!ts) return 'Never'
  const secs = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000)
  if (secs < 0) return 'just now'
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const statusDot = (s: string) =>
  s === 'online' ? 'bg-green-400' : s === 'error' ? 'bg-amber-400' : 'bg-red-400'

const statusText = (s: string) =>
  s === 'online' ? 'text-green-400' : s === 'error' ? 'text-amber-400' : 'text-red-400'

function SyncBadge({ status, error }: { status: string | null; error: string | null }) {
  if (!status || status === 'unknown') return <span className="text-xs text-gray-600">—</span>
  if (status === 'synced')
    return <span className="text-xs text-green-400 font-medium">✓ synced</span>
  if (status === 'error')
    return (
      <span className="text-xs text-red-400 font-medium" title={error ?? ''}>✗ error</span>
    )
  return <span className="text-xs text-yellow-400">{status}</span>
}

// ── SSH config modal ──────────────────────────────────────────────────────────

interface SSHFormState {
  ssh_host: string
  ssh_port: string
  ssh_user: string
  ssh_auth_type: 'key' | 'password'
  // key
  keyMode: 'keep' | 'paste' | 'upload'   // 'keep' = no change
  keyText: string                          // pasted PEM
  // password
  passwordMode: 'keep' | 'new'
  passwordText: string
  // otelcol
  otelcol_config_path: string
  otelcol_service: string
}

function SSHModal({ collector, onClose, onSaved }: {
  collector: Collector
  onClose: () => void
  onSaved: (updated: Collector) => void
}) {
  const keyHasSaved  = !!collector.ssh_key_enc
  const pwdHasSaved  = !!collector.ssh_password_enc

  const [form, setForm] = useState<SSHFormState>({
    ssh_host: collector.ssh_host ?? '',
    ssh_port: String(collector.ssh_port ?? 22),
    ssh_user: collector.ssh_user ?? 'ssh-user',
    ssh_auth_type: (collector.ssh_auth_type as 'key' | 'password') ?? 'key',
    keyMode: keyHasSaved ? 'keep' : 'paste',
    keyText: '',
    passwordMode: pwdHasSaved ? 'keep' : 'new',
    passwordText: '',
    otelcol_config_path: collector.otelcol_config_path ?? '/mnt/software/otel/config/otelcol-config.yaml',
    otelcol_service: collector.otelcol_service ?? 'otelcol',
  })

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [deletingKey, setDeletingKey] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })
  const setF = <K extends keyof SSHFormState>(k: K, v: SSHFormState[K]) => setForm(f => ({ ...f, [k]: v }))

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setF('keyText', (ev.target?.result as string) ?? '')
      setF('keyMode', 'paste')
    }
    reader.readAsText(file)
  }

  const save = async () => {
    setSaving(true); setError('')
    const payload: Record<string, unknown> = {
      ssh_host: form.ssh_host || null,
      ssh_port: parseInt(form.ssh_port) || 22,
      ssh_user: form.ssh_user || null,
      ssh_auth_type: form.ssh_auth_type,
      otelcol_config_path: form.otelcol_config_path,
      otelcol_service: form.otelcol_service,
    }
    if (form.ssh_auth_type === 'key' && form.keyMode !== 'keep') {
      payload.ssh_key = form.keyText || null
    }
    if (form.ssh_auth_type === 'password' && form.passwordMode !== 'keep') {
      payload.ssh_password = form.passwordText || null
    }
    try {
      const res = await fetch(`/api/snmp/collectors/${collector.id}/ssh`, {
        method: 'PUT', headers: authHeader(), body: JSON.stringify(payload),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      // Refetch to get updated masks
      const r2 = await fetch(`/api/snmp/collectors/${collector.id}`, { headers: authHeader() })
      const updated = await r2.json()
      onSaved(updated)
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  const testSSH = async () => {
    setTesting(true); setTestResult(null)
    try {
      const res = await fetch(`/api/snmp/collectors/${collector.id}/test-ssh`, {
        method: 'POST', headers: authHeader(),
      })
      let data: any
      try { data = await res.json() } catch { data = { ok: false, message: `HTTP ${res.status} — server returned non-JSON response` } }
      setTestResult({ ok: data.ok ?? false, message: data.message ?? data.detail ?? `HTTP ${res.status}` })
    } catch (e: any) { setTestResult({ ok: false, message: e.message }) } finally { setTesting(false) }
  }

  const deleteKey = async () => {
    setDeletingKey(true)
    try {
      await fetch(`/api/snmp/collectors/${collector.id}/ssh-key`, { method: 'DELETE', headers: authHeader() })
      setF('keyMode', 'paste')
    } catch {} finally { setDeletingKey(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">SSH Config — {collector.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Admin <span className="text-amber-500">•</span> Credentials encrypted at rest. Keys are write-only once saved.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Connection */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-gray-400 block mb-1">Host (override)</label>
              <input value={form.ssh_host} onChange={e => setF('ssh_host', e.target.value)}
                placeholder={collector.ip ?? 'uses collector IP'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <p className="text-xs text-gray-600 mt-0.5">Leave blank to use collector IP</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Port</label>
              <input type="number" value={form.ssh_port} onChange={e => setF('ssh_port', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">SSH username</label>
            <input value={form.ssh_user} onChange={e => setF('ssh_user', e.target.value)} placeholder="ssh-user"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>

          {/* Auth type */}
          <div>
            <label className="text-xs text-gray-400 block mb-1.5">Authentication</label>
            <div className="flex gap-2">
              {(['key', 'password'] as const).map(t => (
                <button key={t} type="button" onClick={() => setF('ssh_auth_type', t)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    form.ssh_auth_type === t
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                  }`}>
                  {t === 'key' ? 'SSH key' : 'Password'}
                </button>
              ))}
            </div>
          </div>

          {/* SSH key section */}
          {form.ssh_auth_type === 'key' && (
            <div className="space-y-2">
              {keyHasSaved && form.keyMode === 'keep' ? (
                <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-300 font-mono">•••• SSH key saved</span>
                  <div className="flex gap-3">
                    <button onClick={() => setF('keyMode', 'paste')} className="text-xs text-blue-400 hover:text-blue-300">Replace</button>
                    <button onClick={deleteKey} disabled={deletingKey} className="text-xs text-red-400 hover:text-red-300">
                      {deletingKey ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">PEM key</label>
                    <span className="text-xs text-gray-600">(paste or upload — never shown after save)</span>
                    <button type="button" onClick={() => fileRef.current?.click()}
                      className="ml-auto text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded">
                      Upload file
                    </button>
                    <input ref={fileRef} type="file" accept=".pem,.key" className="hidden" onChange={handleFileUpload} />
                  </div>
                  <textarea
                    value={form.keyText}
                    onChange={e => setF('keyText', e.target.value)}
                    placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
                    rows={5}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                  />
                  {keyHasSaved && (
                    <button onClick={() => setF('keyMode', 'keep')} className="text-xs text-gray-500 hover:text-gray-300">← Keep existing key</button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Password section */}
          {form.ssh_auth_type === 'password' && (
            <div className="space-y-2">
              {pwdHasSaved && form.passwordMode === 'keep' ? (
                <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-300 font-mono">•••• Password saved</span>
                  <button onClick={() => setF('passwordMode', 'new')} className="text-xs text-blue-400 hover:text-blue-300">Replace</button>
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 block">SSH password (encrypted at rest)</label>
                  <input type="password" value={form.passwordText} onChange={e => setF('passwordText', e.target.value)}
                    placeholder="password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  {pwdHasSaved && (
                    <button onClick={() => setF('passwordMode', 'keep')} className="text-xs text-gray-500 hover:text-gray-300">← Keep existing password</button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* otelcol paths */}
          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-gray-800">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Config path</label>
              <input value={form.otelcol_config_path} onChange={e => setF('otelcol_config_path', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Service name</label>
              <input value={form.otelcol_service} onChange={e => setF('otelcol_service', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          {testResult && (
            <div className={`rounded-lg px-3 py-2 text-xs ${testResult.ok
              ? 'bg-green-900/20 border border-green-700/40 text-green-400'
              : 'bg-red-900/20 border border-red-700/40 text-red-400'}`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
            <button onClick={save} disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Save SSH Config'}
            </button>
            <button onClick={testSSH} disabled={testing || saving}
              className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg disabled:opacity-50 transition-colors">
              {testing ? 'Testing…' : 'Test SSH'}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── YAML preview modal ────────────────────────────────────────────────────────

function PreviewModal({ collectorId, collectorName, onClose }: {
  collectorId: number; collectorName: string; onClose: () => void
}) {
  const [yaml, setYaml]     = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}` })

  useEffect(() => {
    fetch(`/api/snmp/collectors/${collectorId}/preview-config`, { headers: authHeader() })
      .then(r => {
        if (!r.ok) return r.json().catch(() => ({})).then(d => { throw new Error(d.detail || `HTTP ${r.status}`) })
        return r.json()
      })
      .then(d => { if (d.yaml) setYaml(d.yaml); else setError(d.detail || 'Failed') })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [collectorId])

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-gray-950 border border-gray-700 rounded-xl w-full max-w-3xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Config Preview — {collectorName}</h2>
          <div className="flex items-center gap-3">
            {yaml && (
              <button onClick={() => navigator.clipboard.writeText(yaml)}
                className="text-xs text-gray-400 hover:text-white">Copy</button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
          </div>
        </div>
        <div className="p-4">
          {loading && <div className="text-sm text-gray-400 py-8 text-center">Generating preview…</div>}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {yaml && (
            <pre className="text-xs text-green-300 bg-gray-900 rounded-lg p-4 overflow-x-auto max-h-[60vh] overflow-y-auto whitespace-pre font-mono">
              {yaml}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Collectors() {
  const [collectors, setCollectors] = useState<Collector[]>([])
  const [loading, setLoading]       = useState(true)
  const [showAdd, setShowAdd]       = useState(false)
  const [form, setForm]             = useState({ name: '', description: '', ip: '' })
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [newToken, setNewToken]     = useState<{ id: number; token: string } | null>(null)
  const [rotating, setRotating]     = useState<number | null>(null)
  const [sshModal, setSSHModal]     = useState<Collector | null>(null)
  const [preview, setPreview]       = useState<{ id: number; name: string } | null>(null)
  const [syncing, setSyncing]       = useState<number | null>(null)
  const [syncResult, setSyncResult] = useState<{ id: number; ok: boolean; message: string } | null>(null)
  const [ingestRates, setIngestRates] = useState<Record<number, IngestRateBucket[]>>({})

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/snmp/collectors', { headers: authHeader() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: Collector[] = await res.json()
      setCollectors(Array.isArray(data) ? data : [])
      // Load ingest-rate sparklines for each collector
      const rates: Record<number, IngestRateBucket[]> = {}
      await Promise.all(
        (Array.isArray(data) ? data : []).map(async (c) => {
          try { rates[c.id] = await api.getCollectorIngestRate(c.id, 1, 5) } catch {}
        })
      )
      setIngestRates(rates)
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const addCollector = async () => {
    if (!form.name) { setError('Name is required'); return }
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/snmp/collectors', { method: 'POST', headers: authHeader(), body: JSON.stringify(form) })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      const data = await res.json()
      setNewToken({ id: data.id, token: data.api_token })
      setForm({ name: '', description: '', ip: '' })
      setShowAdd(false)
      await load()
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  const rotateToken = async (id: number) => {
    setRotating(id)
    try {
      const res = await fetch(`/api/snmp/collectors/${id}/rotate-token`, { method: 'POST', headers: authHeader() })
      const data = await res.json()
      setNewToken({ id, token: data.api_token })
    } catch {} finally { setRotating(null) }
  }

  const deleteCollector = async (id: number) => {
    if (id === 1) return
    try {
      await fetch(`/api/snmp/collectors/${id}`, { method: 'DELETE', headers: authHeader() })
      await load()
    } catch {}
  }

  const syncCollector = async (id: number) => {
    setSyncing(id); setSyncResult(null)
    try {
      const res = await fetch(`/api/snmp/collectors/${id}/sync`, { method: 'POST', headers: authHeader() })
      let data: any
      try { data = await res.json() } catch { data = { ok: false, message: `HTTP ${res.status} — server returned non-JSON response` } }
      setSyncResult({ id, ok: data.ok ?? false, message: data.message ?? data.detail ?? `HTTP ${res.status}` })
      if (res.ok) await load()   // refresh sync_status + last_synced_at
    } catch (e: any) {
      setSyncResult({ id, ok: false, message: e.message })
    } finally { setSyncing(null) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-white">Collectors</h1>
          <p className="text-xs text-gray-500 mt-0.5">Manage remote otelcol collectors and the built-in local collector</p>
        </div>
        <button onClick={() => setShowAdd(v => !v)}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Add Collector
        </button>
      </div>

      {/* New token banner */}
      {newToken && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-4 space-y-2">
          <p className="text-xs font-semibold text-amber-400">⚠ Token shown once — copy it now</p>
          <p className="text-xs text-gray-300">Collector ID: <span className="font-mono text-white">{newToken.id}</span></p>
          <div className="flex items-center gap-2">
            <input readOnly value={newToken.token}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono" />
            <button onClick={() => navigator.clipboard.writeText(newToken.token)}
              className="px-3 py-2 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Copy</button>
          </div>
          <button onClick={() => setNewToken(null)} className="text-xs text-gray-500 hover:text-gray-300">Dismiss</button>
        </div>
      )}

      {/* Sync result banner */}
      {syncResult && (
        <div className={`border rounded-xl px-4 py-3 flex items-start justify-between gap-2 ${
          syncResult.ok
            ? 'bg-green-900/20 border-green-700/40 text-green-400'
            : 'bg-red-900/20 border-red-700/40 text-red-400'}`}>
          <span className="text-xs">{syncResult.ok ? '✓ ' : '✗ '}{syncResult.message}</span>
          <button onClick={() => setSyncResult(null)} className="text-xs opacity-60 hover:opacity-100 flex-shrink-0">✕</button>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <p className="text-xs font-medium text-white">New Collector</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="dental-otelcol"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">IP address</label>
              <input value={form.ip} onChange={e => setForm(f => ({ ...f, ip: e.target.value }))} placeholder="COLLECTOR-2-IP"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Description</label>
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Dental otelcol collector"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button onClick={addCollector} disabled={saving}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors">
              {saving ? 'Creating…' : 'Create'}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {error && !showAdd && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      {/* Collector list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Collector</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden sm:table-cell">IP</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Status</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden md:table-cell">Sync</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden lg:table-cell">Last seen</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {collectors.map(c => (
                <tr key={c.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <p className="text-white font-medium text-sm">{c.name}</p>
                    {c.description && <p className="text-xs text-gray-500">{c.description}</p>}
                    {/* Ingest-rate mini sparkline (last 1h, 5-min buckets) */}
                    {ingestRates[c.id] && ingestRates[c.id].length > 0 && (() => {
                      const buckets = ingestRates[c.id]
                      const maxPoll = Math.max(...buckets.map(b => b.poll_count), 1)
                      const totalPolls = buckets.reduce((s, b) => s + b.poll_count, 0)
                      return (
                        <div className="mt-1.5">
                          <div className="flex items-end gap-0.5 h-5">
                            {buckets.map((b, i) => (
                              <div
                                key={i}
                                className="flex-1 rounded-sm bg-blue-500/60 hover:bg-blue-400/80 transition-colors"
                                style={{ height: `${Math.max((b.poll_count / maxPoll) * 100, 4)}%` }}
                                title={`${b.bucket_ts}: ${b.poll_count} polls, ${b.active_devices} devices`}
                              />
                            ))}
                          </div>
                          <p className="text-xs text-gray-600 mt-0.5">{totalPolls} polls/h</p>
                        </div>
                      )
                    })()}
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {c.id === 1 && <span className="text-xs text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">built-in</span>}
                      {c.id !== 1 && c.ssh_key_enc &&
                        <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">key</span>}
                      {c.id !== 1 && c.ssh_password_enc && !c.ssh_key_enc &&
                        <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">pwd</span>}
                      {c.id !== 1 && !c.ssh_key_enc && !c.ssh_password_enc &&
                        <span className="text-xs text-amber-600 bg-amber-900/20 px-1.5 py-0.5 rounded">no SSH creds</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-gray-300 text-xs hidden sm:table-cell">{c.ip ?? '—'}</td>
                  <td className="px-5 py-3">
                    <div className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(c.effective_status)}`}></span>
                        <span className={`capitalize ${statusText(c.effective_status)}`}>{c.effective_status}</span>
                      </span>
                      {c.effective_status === 'error' && c.auth_failure_count > 0 && (
                        <p className="text-amber-600 mt-0.5 ml-3.5"
                           title={c.last_auth_failure_at ? `Last at: ${c.last_auth_failure_at}` : ''}>
                          Auth failures: {c.auth_failure_count}
                        </p>
                      )}
                      {c.effective_status === 'offline' && (
                        <p className="text-gray-600 mt-0.5 ml-3.5">
                          {c.last_seen ? `Last: ${fmtRelative(c.last_seen)}` : 'Never connected'}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 hidden md:table-cell">
                    <div>
                      <SyncBadge status={c.sync_status} error={c.last_sync_error} />
                      {c.last_synced_at && (
                        <p className="text-xs text-gray-600">{fmtRelative(c.last_synced_at)}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden lg:table-cell">{fmtRelative(c.last_seen)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3 justify-end flex-wrap">
                      {/* Admin controls */}
                      {c.id !== 1 && (
                        <>
                          <button onClick={() => { setSyncing(c.id); void syncCollector(c.id) }}
                            disabled={syncing === c.id}
                            className="text-xs text-gray-400 hover:text-green-400 transition-colors disabled:opacity-50"
                            title="Push device config to this collector [Admin]">
                            {syncing === c.id ? 'Syncing…' : '↑ Sync'}
                          </button>
                          <button onClick={() => setPreview({ id: c.id, name: c.name })}
                            className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                            title="Preview config that would be pushed [Admin]">
                            Preview
                          </button>
                          <button onClick={() => setSSHModal(c)}
                            className="text-xs text-gray-400 hover:text-amber-400 transition-colors"
                            title="Configure SSH access [Admin]">
                            SSH
                          </button>
                        </>
                      )}
                      <button onClick={() => rotateToken(c.id)} disabled={rotating === c.id}
                        className="text-xs text-gray-400 hover:text-amber-400 transition-colors disabled:opacity-50"
                        title="Rotate API token [Admin]">
                        {rotating === c.id ? 'Rotating…' : 'Token'}
                      </button>
                      {c.id !== 1 && (
                        <button onClick={() => deleteCollector(c.id)} className="text-xs text-gray-400 hover:text-red-400 transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {collectors.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-gray-500">No collectors configured</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      {sshModal && (
        <SSHModal
          collector={sshModal}
          onClose={() => setSSHModal(null)}
          onSaved={updated => {
            setCollectors(cs => cs.map(c => c.id === updated.id ? updated : c))
            setSSHModal(null)
          }}
        />
      )}
      {preview && (
        <PreviewModal
          collectorId={preview.id}
          collectorName={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
