import { useEffect, useRef, useState } from 'react'
import { api, getToken, HierarchyOrg } from '../api/client'

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
  id: number; name: string; ip: string
  org: string         // Org (top level)
  groups: string      // Group (second level; DB column 'groups')
  site: string        // Site (third level; DB column 'site', was 'location')
  device_type: string // firewall|switch|wap|wlc|router|iot|ups|server|storage|pdu|camera|load_balancer|vpn|printer|other|''
  collector_id: number; collector_name?: string; credential_id: number | null
  credential_name?: string; cred_snmp_version?: string
  otelcol_label: string | null; enabled: number; status: string; last_seen: string | null
  last_error: string | null; poll_interval_override: number | null
  parent_device_id: number | null
  ha_role: string | null     // 'active' | 'passive' | 'standalone' | null
  ha_peer_id: number | null  // ID of the HA partner device
}

const DEVICE_TYPES = [
  { value: '',             label: '— unset —' },
  { value: 'firewall',     label: 'Firewall' },
  { value: 'router',       label: 'Router' },
  { value: 'switch',       label: 'Switch' },
  { value: 'wap',          label: 'WAP (Access Point)' },
  { value: 'wlc',          label: 'WLC (Wireless Controller)' },
  { value: 'server',       label: 'Server / Computer' },
  { value: 'storage',      label: 'Storage (NAS/SAN)' },
  { value: 'ups',          label: 'UPS' },
  { value: 'pdu',          label: 'PDU' },
  { value: 'camera',       label: 'Camera / NVR' },
  { value: 'load_balancer',label: 'Load Balancer' },
  { value: 'vpn',          label: 'VPN Concentrator' },
  { value: 'printer',      label: 'Printer / Copier' },
  { value: 'iot',          label: 'IoT' },
  { value: 'other',        label: 'Other' },
]

interface DeviceFormState {
  name: string; ip: string
  org: string; groups: string; site: string; device_type: string
  collector_id: number; credential_id: number | ''
  otelcol_label: string; enabled: boolean; poll_interval_override: string
  parent_device_id: number | ''
  ha_role: string
  ha_peer_id: number | ''
}

const EMPTY_DEVICE: DeviceFormState = {
  name: '', ip: '',
  org: '', groups: '', site: '', device_type: '',
  collector_id: 1, credential_id: '',
  otelcol_label: '', enabled: true, poll_interval_override: '',
  parent_device_id: '',
  ha_role: '',
  ha_peer_id: '',
}

function DeviceFormModal({ device, collectors, credentials, allDevices, hierarchyOrgs, onClose, onSaved }: {
  device: Device | null
  collectors: Collector[]
  credentials: Credential[]
  allDevices: Device[]
  hierarchyOrgs: HierarchyOrg[]
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!device
  const [form, setForm] = useState<DeviceFormState>(
    editing ? {
      name: device!.name, ip: device!.ip,
      org: device!.org ?? '',
      groups: device!.groups ?? '',
      site: device!.site ?? '',
      device_type: device!.device_type ?? '',
      collector_id: device!.collector_id,
      credential_id: device!.credential_id ?? '',
      otelcol_label: device!.otelcol_label ?? '',
      enabled: !!device!.enabled,
      poll_interval_override: device!.poll_interval_override?.toString() ?? '',
      parent_device_id: device!.parent_device_id ?? '',
      ha_role: device!.ha_role ?? '',
      ha_peer_id: device!.ha_peer_id ?? '',
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
      name: form.name, ip: form.ip,
      org: form.org, groups: form.groups, site: form.site,
      device_type: form.device_type,
      collector_id: Number(form.collector_id),
      credential_id: Number(form.credential_id),
      poll_interval_override: form.poll_interval_override ? parseInt(form.poll_interval_override) : null,
      otelcol_label: form.otelcol_label || null,
      enabled: form.enabled,
      parent_device_id: form.parent_device_id !== '' ? Number(form.parent_device_id) : null,
      ha_role: form.ha_role || null,
      ha_peer_id: form.ha_peer_id !== '' ? Number(form.ha_peer_id) : null,
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

          {/* Org / Group / Site — cascading selects from hierarchy definition */}
          {(() => {
            const orgOptions    = hierarchyOrgs.map(o => o.name)
            const selectedOrg   = hierarchyOrgs.find(o => o.name === form.org) ?? null
            const groupOptions  = selectedOrg ? selectedOrg.groups.map(g => g.name) : []
            const selectedGroup = selectedOrg?.groups.find(g => g.name === form.groups) ?? null
            const siteOptions   = selectedGroup ? selectedGroup.sites.map(s => s.name) : []

            // If a saved value isn't in the hierarchy (device predates hierarchy definition),
            // add it as an option so the form doesn't silently lose it.
            const orgList    = [...new Set([...(form.org    ? [form.org]    : []), ...orgOptions])]
            const groupList  = [...new Set([...(form.groups ? [form.groups] : []), ...groupOptions])]
            const siteList   = [...new Set([...(form.site   ? [form.site]   : []), ...siteOptions])]

            const selectCls = "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"

            return (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Org</label>
                  <select
                    value={form.org}
                    onChange={e => {
                      setF('org', e.target.value)
                      setF('groups', '')
                      setF('site', '')
                    }}
                    className={selectCls}
                  >
                    <option value="">— unassigned —</option>
                    {orgList.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  {hierarchyOrgs.length === 0 && (
                    <p className="text-xs text-amber-500 mt-0.5">Define orgs in Settings → Hierarchy</p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Group</label>
                  <select
                    value={form.groups}
                    onChange={e => {
                      setF('groups', e.target.value)
                      setF('site', '')
                    }}
                    disabled={!form.org && groupList.length === 0}
                    className={selectCls}
                  >
                    <option value="">— unassigned —</option>
                    {groupList.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Site</label>
                  <select
                    value={form.site}
                    onChange={e => setF('site', e.target.value)}
                    disabled={!form.groups && siteList.length === 0}
                    className={selectCls}
                  >
                    <option value="">— unassigned —</option>
                    {siteList.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
            )
          })()}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Device type</label>
              <select value={form.device_type} onChange={e => setF('device_type', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {DEVICE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
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
            <label className="text-xs text-gray-400 block mb-1">Parent device</label>
            <select value={form.parent_device_id} onChange={e => setF('parent_device_id', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">— none (root node) —</option>
              {allDevices
                .filter(d => d.id !== device?.id)  // can't be own parent
                .map(d => (
                  <option key={d.id} value={d.id}>{d.name} ({d.ip})</option>
                ))}
            </select>
            <p className="text-xs text-gray-600 mt-0.5">Sets position in the dashboard topology tree</p>
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">HA role</label>
            <select value={form.ha_role} onChange={e => setF('ha_role', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">— none —</option>
              <option value="active">Active</option>
              <option value="passive">Passive (standby)</option>
              <option value="standalone">Standalone</option>
            </select>
            <p className="text-xs text-gray-600 mt-0.5">HA pair state — passive devices show a standby badge</p>
          </div>

          {(form.ha_role === 'active' || form.ha_role === 'passive') && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">HA peer device</label>
              <select value={form.ha_peer_id} onChange={e => setF('ha_peer_id', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                <option value="">— none —</option>
                {allDevices
                  .filter(d => d.id !== device?.id && (d.ha_role === 'active' || d.ha_role === 'passive'))
                  .map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.ip}) — {d.ha_role}</option>
                  ))}
              </select>
              <p className="text-xs text-gray-600 mt-0.5">Link the active/passive pair so downstream devices appear correctly in the topology tree</p>
            </div>
          )}

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
              <label className="text-xs text-gray-400 block mb-1">Poll interval override (s)</label>
              <input type="number" value={form.poll_interval_override} onChange={e => setF('poll_interval_override', e.target.value)}
                placeholder="60 (use global default)"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setF('enabled', !form.enabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.enabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${form.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <label className="text-sm text-gray-300">Enabled</label>
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
  const [hierarchyOrgs, setHierarchyOrgs] = useState<HierarchyOrg[]>([])
  const [loading, setLoading]         = useState(true)
  const [modal, setModal]             = useState<Device | null | 'new'>(null)
  const [confirm, setConfirm]         = useState<Device | null>(null)
  const [filter, setFilter]           = useState('')
  const [collectorFilter, setCollectorFilter] = useState<number | 'all'>('all')
  const [error, setError]             = useState('')
  const [exporting, setExporting]     = useState(false)
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null)
  const importFileRef                 = useRef<HTMLInputElement>(null)

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
      // Load hierarchy for cascading selects (non-fatal if unavailable)
      try { setHierarchyOrgs(await api.getHierarchy()) } catch {}
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

  const handleDownloadTemplate = () => {
    const rows = [
      ['name', 'ip', 'org', 'groups', 'site', 'device_type', 'otelcol_label', 'enabled', 'poll_interval_override', 'ha_role', 'collector_name', 'credential_name'],
      ['Core-FW-01',   '10.0.0.1',  'Vyne Dental', 'QTS',      'MDF',   'firewall', 'QTS/FW1',  'true',  '',   'active',     'Local Collector', 'v2c-public'],
      ['Core-SW-01',   '10.0.0.2',  'Vyne Dental', 'QTS',      'MDF',   'switch',   'QTS/SW1',  'true',  '60', '',           'Local Collector', 'v2c-public'],
      ['Access-WAP-01','10.0.1.10', 'Vyne Dental', 'Branch-A', 'IDF-1', 'wap',      '',         'true',  '',   '',           'Local Collector', 'v3-secure'],
      ['UPS-Main',     '10.0.2.5',  'Vyne Dental', 'QTS',      'MDF',   'ups',      '',         'true',  '',   '',           'Local Collector', 'v2c-public'],
    ]
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'pktsnmp-devices-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleExport = async () => {
    setExporting(true)
    try { await api.exportDevices() }
    catch (e: any) { setError(e.message) }
    finally { setExporting(false) }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const result = await api.importDevices(file)
      setImportResult(result)
      if (result.created > 0) await load()
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
    return d.name.toLowerCase().includes(q) || d.ip.includes(q)
      || (d.org ?? '').toLowerCase().includes(q)
      || (d.groups ?? '').toLowerCase().includes(q)
      || (d.site ?? '').toLowerCase().includes(q)
  })

  const statusDot = (s: string, enabled: number) => {
    if (!enabled) return 'bg-gray-600'
    return s === 'up' ? 'bg-green-400' : s === 'down' ? 'bg-red-400' : 'bg-gray-500'
  }

  const fmtRelative = (ts: string | null) => {
    if (!ts) return '—'
    const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
    const secs = Math.floor((Date.now() - new Date(utc).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-white">Devices</h1>
          <p className="text-xs text-gray-500 mt-0.5">{devices.length} device{devices.length !== 1 ? 's' : ''} registered</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} disabled={exporting}
            className="px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors disabled:opacity-50">
            {exporting ? 'Exporting…' : '↓ Export CSV'}
          </button>
          <div className="flex items-center gap-1">
            <button onClick={() => importFileRef.current?.click()}
              className="px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors rounded-r-none border-r border-gray-600">
              ↑ Import CSV
            </button>
            <button onClick={handleDownloadTemplate} title="Download CSV template"
              className="px-2 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white rounded-lg transition-colors rounded-l-none"
              aria-label="Download template">
              template
            </button>
          </div>
          <input ref={importFileRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
          <button onClick={() => setModal('new')}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
            + Add Device
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by name, IP, org, group, site…"
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
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-sm font-medium ${d.enabled ? 'text-white' : 'text-gray-500'}`}>{d.name}</p>
                      {d.device_type && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800/80 text-gray-400 border border-gray-700/60">
                          {DEVICE_TYPES.find(t => t.value === d.device_type)?.label.split(' ')[0] ?? d.device_type}
                        </span>
                      )}
                      {d.ha_role && (
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                          d.ha_role === 'active'
                            ? 'bg-blue-900/40 text-blue-300 border border-blue-700/40'
                            : d.ha_role === 'passive'
                            ? 'bg-gray-800 text-gray-400 border border-gray-700'
                            : 'bg-gray-800 text-gray-500 border border-gray-700'
                        }`}>{d.ha_role}</span>
                      )}
                    </div>
                    {(d.org || d.groups || d.site) && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {[d.org, d.groups, d.site].filter(Boolean).join(' › ')}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-gray-300 text-xs hidden sm:table-cell">{d.ip}</td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden md:table-cell">
                    {d.collector_name ?? `#${d.collector_id}`}
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden lg:table-cell">{d.credential_name ?? '—'}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(d.status, d.enabled)}`}></span>
                      <span className="text-gray-300 capitalize">{d.enabled ? d.status : 'disabled'}</span>
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden xl:table-cell">{fmtRelative(d.last_seen)}</td>
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
          allDevices={devices}
          hierarchyOrgs={hierarchyOrgs}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load() }}
        />
      )}

      {importResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 py-8 px-4" onClick={() => setImportResult(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-3">Import complete</h3>
            <div className="space-y-1 mb-4">
              <p className="text-sm text-green-400">✓ {importResult.created} device{importResult.created !== 1 ? 's' : ''} created</p>
              {importResult.skipped > 0 && (
                <p className="text-sm text-yellow-400">⚠ {importResult.skipped} row{importResult.skipped !== 1 ? 's' : ''} skipped</p>
              )}
            </div>
            {importResult.errors.length > 0 && (
              <div className="bg-gray-800 rounded-lg px-3 py-2 max-h-36 overflow-y-auto mb-4">
                {importResult.errors.map((e, i) => (
                  <p key={i} className="text-xs text-red-400 font-mono">{e}</p>
                ))}
              </div>
            )}
            <div className="bg-gray-800/60 rounded-lg px-3 py-2 mb-4">
              <p className="text-xs font-medium text-gray-400 mb-1">CSV columns (header row required)</p>
              <p className="text-xs font-mono text-gray-500 break-all">
                name, ip, org, groups, site, device_type, otelcol_label, enabled, poll_interval_override, ha_role, collector_name, credential_name
              </p>
              <p className="text-xs text-gray-600 mt-1">
                device_type: firewall · router · switch · wap · wlc · server · storage · ups · pdu · camera · load_balancer · vpn · printer · iot · other
              </p>
            </div>
            <div className="flex items-center justify-between">
              <button onClick={handleDownloadTemplate} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                ↓ Download template
              </button>
              <button onClick={() => setImportResult(null)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                Done
              </button>
            </div>
          </div>
        </div>
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
