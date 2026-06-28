import { useEffect, useState } from 'react'
import { getToken } from '../api/client'

interface Collector {
  id: number; name: string; description: string; ip: string | null
  last_seen: string | null; status: string; created_at: string
}

export default function Collectors() {
  const [collectors, setCollectors] = useState<Collector[]>([])
  const [loading, setLoading]       = useState(true)
  const [showAdd, setShowAdd]       = useState(false)
  const [form, setForm]             = useState({ name: '', description: '', ip: '' })
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [newToken, setNewToken]     = useState<{ id: number; token: string } | null>(null)
  const [rotating, setRotating]     = useState<number | null>(null)

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/snmp/collectors', { headers: authHeader() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCollectors(Array.isArray(data) ? data : [])
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

  const fmtRelative = (ts: string | null) => {
    if (!ts) return 'Never'
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  const statusDot = (s: string) =>
    s === 'online' ? 'bg-green-400' : s === 'offline' ? 'bg-red-400' : 'bg-gray-500'

  return (
    <div className="max-w-5xl mx-auto space-y-4">
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

      {newToken && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-4 space-y-2">
          <p className="text-xs font-semibold text-amber-400">⚠ Token shown once — copy it now</p>
          <p className="text-xs text-gray-300">Collector ID: <span className="font-mono text-white">{newToken.id}</span></p>
          <div className="flex items-center gap-2">
            <input readOnly value={newToken.token}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white font-mono" />
            <button onClick={() => { navigator.clipboard.writeText(newToken.token) }}
              className="px-3 py-2 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Copy</button>
          </div>
          <button onClick={() => setNewToken(null)} className="text-xs text-gray-500 hover:text-gray-300">Dismiss</button>
        </div>
      )}

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
              <input value={form.ip} onChange={e => setForm(f => ({ ...f, ip: e.target.value }))} placeholder="10.56.57.181"
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

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-white text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden sm:table-cell">IP</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Last seen</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Status</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {collectors.map(c => (
                <tr key={c.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <p className="text-white font-medium text-sm">{c.name}</p>
                    {c.description && <p className="text-xs text-gray-500">{c.description}</p>}
                    {c.id === 1 && <span className="text-xs text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">built-in</span>}
                  </td>
                  <td className="px-5 py-3 font-mono text-gray-300 text-xs hidden sm:table-cell">{c.ip ?? '—'}</td>
                  <td className="px-5 py-3 text-gray-400 text-xs">{fmtRelative(c.last_seen)}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(c.status)}`}></span>
                      <span className="text-gray-300 capitalize">{c.status}</span>
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3 justify-end">
                      <button onClick={() => rotateToken(c.id)} disabled={rotating === c.id}
                        className="text-xs text-gray-400 hover:text-amber-400 transition-colors disabled:opacity-50">
                        {rotating === c.id ? 'Rotating…' : 'Rotate Token'}
                      </button>
                      {c.id !== 1 && (
                        <button onClick={() => deleteCollector(c.id)} className="text-xs text-gray-400 hover:text-red-400 transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {collectors.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-500">No collectors configured</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
