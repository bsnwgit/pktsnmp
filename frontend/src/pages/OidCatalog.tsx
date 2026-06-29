import { useEffect, useState } from 'react'
import { getToken } from '../api/client'

interface OidEntry {
  id: number; oid: string; name: string; description: string
  unit: string; data_type: string; source: string; created_at: string
}

interface OidFormState {
  oid: string; name: string; description: string; unit: string; data_type: string
}

const EMPTY_OID: OidFormState = { oid: '', name: '', description: '', unit: '', data_type: 'gauge' }

function OidFormModal({ entry, onClose, onSaved }: {
  entry: OidEntry | null; onClose: () => void; onSaved: () => void
}) {
  const editing = !!entry
  const [form, setForm] = useState<OidFormState>(
    editing ? { oid: entry!.oid, name: entry!.name, description: entry!.description, unit: entry!.unit, data_type: entry!.data_type }
            : { ...EMPTY_OID }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })
  const setF = (k: keyof OidFormState, v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setError('')
    try {
      const url    = editing ? `/api/snmp/oids/${entry!.id}` : '/api/snmp/oids'
      const method = editing ? 'PUT' : 'POST'
      const res    = await fetch(url, { method, headers: authHeader(), body: JSON.stringify(form) })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{editing ? `Edit — ${entry!.name}` : 'Add OID'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1">OID string *</label>
            <input value={form.oid} onChange={e => setF('oid', e.target.value)} required disabled={editing}
              placeholder="1.3.6.1.2.1.1.1.0"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Name *</label>
              <input value={form.name} onChange={e => setF('name', e.target.value)} required placeholder="sysDescr"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Data type</label>
              <select value={form.data_type} onChange={e => setF('data_type', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {['gauge','counter','string','timeticks','ipaddress'].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Unit</label>
              <input value={form.unit} onChange={e => setF('unit', e.target.value)} placeholder="bps, %, ms…"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Description</label>
              <input value={form.description} onChange={e => setF('description', e.target.value)} placeholder="Optional"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add OID')}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function OidCatalog() {
  const [oids, setOids]       = useState<OidEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState<OidEntry | null | 'new'>(null)
  const [confirm, setConfirm] = useState<OidEntry | null>(null)
  const [error, setError]     = useState('')
  const [filter, setFilter]   = useState('')

  const authHeader = () => ({ Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' })

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/snmp/oids', { headers: authHeader() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setOids(Array.isArray(data) ? data : [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const deleteOid = async (o: OidEntry) => {
    try {
      const res = await fetch(`/api/snmp/oids/${o.id}`, { method: 'DELETE', headers: authHeader() })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed') }
      setConfirm(null); await load()
    } catch (e: any) { setError(e.message) }
  }

  const dtBadge = (t: string) => {
    const m: Record<string, string> = {
      gauge:      'bg-blue-900/40 text-blue-300 border border-blue-700/40',
      counter:    'bg-purple-900/40 text-purple-300 border border-purple-700/40',
      string:     'bg-gray-700 text-gray-300',
      timeticks:  'bg-yellow-900/40 text-yellow-300 border border-yellow-700/40',
      ipaddress:  'bg-green-900/40 text-green-300 border border-green-700/40',
    }
    return m[t] ?? 'bg-gray-700 text-gray-300'
  }

  const filtered = filter
    ? oids.filter(o => o.oid.includes(filter) || o.name.toLowerCase().includes(filter.toLowerCase()) || o.description.toLowerCase().includes(filter.toLowerCase()))
    : oids

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold text-white">OID Catalog</h1>
          <p className="text-xs text-gray-500 mt-0.5">OIDs polled from devices. Bundled entries are read-only; add custom OIDs for your environment.</p>
        </div>
        <button onClick={() => setModal('new')}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Add OID
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by OID, name, or description…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
        {filter && <button onClick={() => setFilter('')} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>}
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
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">OID</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400">Name</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden sm:table-cell">Type</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden md:table-cell">Unit</th>
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 hidden lg:table-cell">Source</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map(o => (
                <tr key={o.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3 font-mono text-gray-300 text-xs">{o.oid}</td>
                  <td className="px-5 py-3">
                    <p className="text-white text-sm">{o.name}</p>
                    {o.description && <p className="text-gray-500 text-xs mt-0.5">{o.description}</p>}
                  </td>
                  <td className="px-5 py-3 hidden sm:table-cell">
                    <span className={`text-xs px-2 py-0.5 rounded font-mono ${dtBadge(o.data_type)}`}>{o.data_type}</span>
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs hidden md:table-cell">{o.unit || '—'}</td>
                  <td className="px-5 py-3 hidden lg:table-cell">
                    <span className={`text-xs px-2 py-0.5 rounded ${o.source === 'bundled' ? 'bg-gray-700 text-gray-400' : 'bg-green-900/30 text-green-400 border border-green-700/40'}`}>
                      {o.source}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {o.source !== 'bundled' && (
                      <div className="flex items-center gap-3 justify-end">
                        <button onClick={() => setModal(o)} className="text-xs text-gray-400 hover:text-blue-400 transition-colors">Edit</button>
                        <button onClick={() => setConfirm(o)} className="text-xs text-gray-400 hover:text-red-400 transition-colors">Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-gray-500">
                  {filter ? 'No OIDs match your filter' : 'No OIDs in catalog'}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {(modal === 'new' || (modal && typeof modal === 'object')) && (
        <OidFormModal
          entry={modal === 'new' ? null : modal as OidEntry}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load() }}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete OID?</h3>
            <p className="text-sm text-gray-300 mb-5">Remove <span className="text-white font-mono">{confirm.oid}</span> ({confirm.name})?</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
              <button onClick={() => deleteOid(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
