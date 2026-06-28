import { useEffect, useState } from 'react'
import { getToken } from '../api/client'

interface Collector {
  id: number; name: string; description: string; ip: string | null
  last_seen: string | null; status: string; created_at: string
}

interface Credential {
  id: number; name: string; description: string; snmp_version: string
  community: string; security_name: string; security_level: string
  auth_protocol: string; auth_key_enc: string; priv_protocol: string; priv_key_enc: string
  created_at: string; updated_at: string
}

interface Device {
  id: number; name: string; ip: string; site: string
  collector_id: number; collector_name?: string; credential_id: number | null
  credential_name?: string; cred_snmp_version?: string; cred_community?: string
  device_snmp_version?: string | null; device_community?: string | null
  otelcol_label: string | null; otelcol_pipeline: string | null
  enabled: number; status: string; last_seen: string | null
  last_error: string | null; poll_interval_override: number | null
  ha_role: string | null
}

interface DeviceFormState {
  name: string; ip: string; site: string
  collector_id: number; credential_id: number | ''
  otelcol_label: string; otelcol_pipeline: string
  enabled: boolean; poll_interval_override: string
  ha_role: string
}

const EMPTY_DEVICE: DeviceFormState = {
  name: '', ip: '', site: '',
  collector_id: 1, credential_id: '',
  otelcol_label: '', otelcol_pipeline: '',
  enabled: true, poll_interval_override: '',
  ha_role: '',
}

const PIPELINE_OPTIONS = [
  { value: '', label: '— none —' },
  { value: 'metrics/switch',   label: 'metrics/switch' },
  { value: 'metrics/firewall', label: 'metrics/firewall' },
  { value: 'metrics/snmp',     label: 'metrics/snmp' },
]

const HA_BADGE: Record<string, string> = {
  active:  'bg-blue-900/40 text-blue-300 border-blue-700/50',
  passive: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
}

function HaBadge({ role }: { role: string | null }) {
  if (!role) return null
  const cls = HA_BADGE[role] ?? 'bg-gray-800 text-gray-400 border-gray-700'
  return (
    <span className={`ml-1.5 text-[10px] font-medium border rounded px-1.5 py-0.5 ${cls}`}>
      HA {role}
    </span>
  )
}

function DeviceFormModal({ device, collectors, credentials, onClose, onSaved }: {
  device: Device | null
  collectors: Collector[]
  credentials: Credential[]
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!device
  const [form, setForm] = useState<DeviceFormState>(
    editing ? {
      name: device!.name, ip: device!.ip, site: device!.site ?? '',
      collector_id: device!.collector_id,
      credential_id: device!.credential_id ?? '',
      otelcol_label: device!.otelcol_label ?? '',
      otelcol_pipeline: device!.otelcol_pipeline ?? '',
      enabled: !!device!.enabled,
      poll_interval_override: device!.poll_interval_override?.toString() ?? '',
      ha_role: device!.ha_role ?? '',
    } : { ...EMPTY_DEVICE }
  )
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; sys_descr?: string; error?: string; latency_ms?: number } | null>(null)

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })
  const setF = (k: keyof DeviceFormState, v: string | boolean | number) => setForm(f => ({ ...f, [k]: v }))

  const selectedCred = credentials.find(c => c.id === Number(form.credential_id)) ?? null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.credential_id) { setError('Select a credential'); return }
    setSaving(true); setError('')
    const payload = {
      name: form.name, ip: form.ip, site: form.site,
      collector_id: Number(form.collector_id),
      credential_id: Number(form.credential_id),
      poll_interval_override: form.poll_interval_override ? parseInt(form.poll_interval_override) : null,
      otelcol_label: form.otelcol_label || null,
      otelcol_pipeline: form.otelcol_pipeline || null,
      enabled: form.enabled,
      ha_role: form.ha_role || null,
    }
    try {
      const url = editing ? `/api/snmp/devices/${device!.id}` : '/api/snmp/devices'
      const method = editing ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: authHeader(), body: JSON.stringify(payload) })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  const testDevice = async () => {
    if (!editing) return
    setTesting(true); setTestResult(null)
    try {
      const res = await fetch(`/api/snmp/devices/${device!.id}/test`, { method: 'POST', headers: authHeader() })
      setTestResult(await res.json())
    } catch (e: any) { setTestResult({ success: false, error: e.message }) } finally { setTesting(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{editing ? `Edit — ${device!.name}` : 'Add Device'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Name *</label>
              <input value={form.name} onChange={e => setF('name', e.target.value)} required placeholder="Core Switch"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">IP address *</label>
              <input value={form.ip} onChange={e => setF('ip', e.target.value)} required placeholder="192.168.1.1"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Site</label>
              <input value={form.site} onChange={e => setF('site', e.target.value)} placeholder="medical"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Collector</label>
              <select value={form.collector_id} onChange={e => setF('collector_id', Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {collectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Credential *</label>
            <select value={form.credential_id} onChange={e => setF('credential_id', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">— select credential —</option>
              {credentials.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.snmp_version}{c.snmp_version === 'v3' ? ` / ${c.security_level}` : ''})
                </option>
              ))}
            </select>
            {selectedCred && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="text-xs bg-blue-900/30 text-blue-300 border border-blue-700/40 rounded px-2 py-0.5">{selectedCred.snmp_version}</span>
                {selectedCred.snmp_version !== 'v3' && <span className="text-xs bg-gray-800 text-gray-400 border border-gray-700 rounded px-2 py-0.5 font-mono tracking-widest">••••••••</span>}
                {selectedCred.snmp_version === 'v3' && <span className="text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded px-2 py-0.5">{selectedCred.security_level}</span>}
                {selectedCred.description && <span className="text-xs text-gray-500">{selectedCred.description}</span>}
              </div>
            )}
            <p className="text-xs text-gray-600 mt-0.5">Manage credentials in Settings → Credentials</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">otelcol label</label>
              <input value={form.otelcol_label} onChange={e => setF('otelcol_label', e.target.value)} placeholder="QTS/SW1"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <p className="text-xs text-gray-500 mt-0.5">Matches SNMP/LABEL in otelcol metric names</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">otelcol pipeline</label>
              <select value={form.otelcol_pipeline} onChange={e => setF('otelcol_pipeline', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {PIPELINE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p className="text-xs text-gray-500 mt-0.5">Pipeline this device is added to on Sync</p>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Poll interval override (s)</label>
            <input type="number" value={form.poll_interval_override} onChange={e => setF('poll_interval_override', e.target.value)}
              placeholder="60 (use global default)"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">HA role</label>
              <select value={form.ha_role} onChange={e => setF('ha_role', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                <option value="">— none —</option>
                <option value="active">Active</option>
                <option value="passive">Passive (standby)</option>
              </select>
              <p className="text-xs text-gray-500 mt-0.5">Passive nodes may not respond to SNMP polls</p>
            </div>
            <div className="flex items-end pb-1">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setF('enabled', !form.enabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.enabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
                  <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${form.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
                <label className="text-sm text-gray-300">Enabled</label>
              </div>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add Device')}
            </button>
            {editing && (
              <button type="button" onClick={testDevice} disabled={testing}
                className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors disabled:opacity-50">
                {testing ? 'Testing…' : 'Test SNMP'}
              </button>
            )}
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>

          {testResult && (
            <div className={`rounded-lg px-3 py-2 text-xs ${testResult.success ? 'bg-green-900/20 border border-green-700/40 text-green-400' : 'bg-red-900/20 border border-red-700/40 text-red-400'}`}>
              {testResult.success ? (
                <>✓ Reachable in {testResult.latency_ms}ms — {testResult.sys_descr}</>
              ) : (
                <>✗ {testResult.error}</>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

export default function Devices() {
  const [devices, setDevices]         = useState<Device[]>([])
  const [collectors, setCollectors]   = useState<Collector[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading]         = useState(true)
  const [modal, setModal]             = useState<Device | null | 'new'>(null)
  const [confirm, setConfirm]         = useState<Device | null>(null)
  const [filter, setFilter]           = useState('')
  const [collectorFilter, setCollectorFilter] = useState<number | 'all'>('all')
  const [error, setError]             = useState('')

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })

  const load = async () => {
    setLoading(true)
    try {
      const [devRes, colRes, credRes] = await Promise.all([
        fetch('/api/snmp/devices', { headers: authHeader() }),
        fetch('/api/snmp/collectors', { headers: authHeader() }),
        fetch('/api/snmp/credentials', { headers: authHeader() }),
      ])
      if (!devRes.ok || !colRes.ok || !credRes.ok) throw new Error('Failed to load data')
      const [devData, colData, credData] = await Promise.all([devRes.json(), colRes.json(), credRes.json()])
      setDevices(Array.isArray(devData) ? devData : [])
      setCollectors(Array.isArray(colData) ? colData : [])
      setCredentials(Array.isArray(credData) ? credData : [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const deleteDevice = async (d: Device) => {
    try {
      await fetch(`/api/snmp/devices/${d.id}`, { method: 'DELETE', headers: authHeader() })
      setConfirm(null)
      await load()
    } catch (e: any) { setError(e.message) }
  }

  const toggleEnabled = async (d: Device) => {
    try {
      await fetch(`/api/snmp/devices/${d.id}`, {
        method: 'PUT', headers: authHeader(),
        body: JSON.stringify({ enabled: !d.enabled }),
      })
      await load()
    } catch (e: any) { setError(e.message) }
  }

  const displayed = devices.filter(d => {
    if (collectorFilter !== 'all' && d.collector_id !== collectorFilter) return false
    if (!filter) return true
    const q = filter.toLowerCase()
    return d.name.toLowerCase().includes(q) || d.ip.includes(q) || (d.site ?? '').toLowerCase().includes(q)
  })

  const statusDot = (d: Device) => {
    if (!d.enabled) return 'bg-gray-600'
    if (d.ha_role === 'passive') return 'bg-amber-400'
    return d.status === 'up' ? 'bg-green-400' : d.status === 'down' ? 'bg-red-400' : 'bg-gray-500'
  }

  const statusLabel = (d: Device) => {
    if (!d.enabled) return 'disabled'
    if (d.ha_role === 'passive') return 'standby'
    return d.status
  }

  const fmtRelative = (ts: string | null) => {
    if (!ts) return '—'
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-white">Devices</h1>
          <p className="text-xs text-gray-500 mt-0.5">{devices.length} device{devices.length !== 1 ? 's' : ''} registered</p>
        </div>
        <button onClick={() => setModal('new')}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Add Device
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by name, IP, site…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 w-52 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        {filter && <button onClick={() => setFilter('')} className="text-xs text-gray-500 hover:text-gray-300">✕</button>}
        <select value={String(collectorFilter)} onChange={e => setCollectorFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
          <option value="all">All collectors</option>
          {collectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="text-xs text-gray-500">{displayed.length} of {devices.length}</span>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Device</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden sm:table-cell">IP</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden md:table-cell">Collector</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden lg:table-cell">Credential</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Status</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden xl:table-cell">Last seen</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {displayed.map(d => (
                <tr key={d.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center flex-wrap gap-x-1">
                      <p className={`text-sm font-medium ${d.enabled ? 'text-white' : 'text-gray-500'}`}>{d.name}</p>
                      <HaBadge role={d.ha_role} />
                    </div>
                    {d.site && <p className="text-xs text-gray-500">{d.site}</p>}
                  </td>
                  <td className="px-5 py-3 font-mono text-gray-300 text-xs hidden sm:table-cell">{d.ip}</td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden md:table-cell">
                    {d.collector_name ?? `#${d.collector_id}`}
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden lg:table-cell">{d.credential_name ?? '—'}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(d)}`}></span>
                      <span className="text-gray-300 capitalize">{statusLabel(d)}</span>
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden xl:table-cell">
                    {d.last_seen ? new Date(d.last_seen.endsWith('Z') ? d.last_seen : d.last_seen + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3 justify-end">
                      <button onClick={() => setModal(d)} className="text-xs text-gray-400 hover:text-blue-400 transition-colors">Edit</button>
                      <button onClick={() => toggleEnabled(d)} className={`text-xs transition-colors ${d.enabled ? 'text-gray-400 hover:text-yellow-400' : 'text-gray-400 hover:text-green-400'}`}>
                        {d.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => setConfirm(d)} className="text-xs text-gray-400 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {displayed.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-gray-500">No devices found</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {(modal === 'new' || (modal && typeof modal === 'object')) && (
        <DeviceFormModal
          device={modal === 'new' ? null : modal as Device}
          collectors={collectors}
          credentials={credentials}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load() }}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete device?</h3>
            <p className="text-sm text-gray-300 mb-5">This will permanently remove <span className="text-white font-medium">{confirm.name}</span> ({confirm.ip}).</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
              <button onClick={() => deleteDevice(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
