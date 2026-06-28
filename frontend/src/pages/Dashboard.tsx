import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, SnmpDashboard, SnmpDevice } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtHour(iso: string): string {
  const d = new Date(iso)
  return d.getHours().toString().padStart(2, '0') + ':00'
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, accent = false, onClick,
}: {
  label: string; value: string | number; sub?: string
  accent?: boolean; onClick?: () => void
}) {
  return (
    <div
      className={`bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 ${onClick ? 'cursor-pointer hover:border-gray-600 transition-colors' : ''}`}
      onClick={onClick}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent && Number(value) > 0 ? 'text-red-400' : 'text-white'}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Trap timeline bar chart (SVG, no library) ─────────────────────────────────

function TrapTimeline({ data }: { data: Array<{ hour: string; count: number }> }) {
  // Build 24 full hourly buckets
  const now = new Date()
  const buckets: Array<{ label: string; count: number }> = []
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now)
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() - i)
    const isoHour = d.toISOString().slice(0, 13)   // "2024-01-01T14"
    const match = data.find(r => r.hour.slice(0, 13) === isoHour)
    buckets.push({ label: fmtHour(d.toISOString()), count: match?.count ?? 0 })
  }

  const maxCount = Math.max(...buckets.map(b => b.count), 1)
  const W = 680
  const H = 120
  const barW = Math.floor(W / 24) - 2
  const padL = 4

  const hasData = buckets.some(b => b.count > 0)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-medium text-white">Trap volume — last 24 hours</p>
        {hasData && (
          <span className="text-xs text-gray-500">{buckets.reduce((s, b) => s + b.count, 0).toLocaleString()} total</span>
        )}
      </div>

      {!hasData ? (
        <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
          No trap data in the last 24 hours
        </div>
      ) : (
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H + 20}`} className="w-full" style={{ minWidth: 400 }}>
            {buckets.map((b, i) => {
              const barH = b.count === 0 ? 2 : Math.max(4, Math.round((b.count / maxCount) * H))
              const x = padL + i * (barW + 2)
              const y = H - barH
              const showLabel = i === 0 || i === 6 || i === 12 || i === 18 || i === 23
              return (
                <g key={i}>
                  <rect
                    x={x} y={y} width={barW} height={barH}
                    rx="2"
                    fill={b.count === 0 ? '#1f2937' : '#3b82f6'}
                    opacity={b.count === 0 ? 0.4 : 0.85}
                  >
                    <title>{b.label}: {b.count} trap{b.count !== 1 ? 's' : ''}</title>
                  </rect>
                  {showLabel && (
                    <text
                      x={x + barW / 2} y={H + 16}
                      textAnchor="middle"
                      fontSize="9"
                      fill="#6b7280"
                    >
                      {b.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      )}
    </div>
  )
}

// ── Device status grid ────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  up:      'bg-green-500',
  down:    'bg-red-500',
  unknown: 'bg-gray-600',
}

const STATUS_LABEL: Record<string, string> = {
  up:      'text-green-400',
  down:    'text-red-400',
  unknown: 'text-gray-500',
}

interface DeviceWithStatus extends SnmpDevice {
  status?: string
  last_seen?: string
}

function DeviceGrid({ devices, loading }: { devices: DeviceWithStatus[]; loading: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
        <p className="text-sm font-medium text-white">Devices</p>
        <button
          onClick={() => navigate('/devices')}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Manage →
        </button>
      </div>
      {loading ? (
        <div className="px-5 py-8 text-sm text-gray-500">Loading…</div>
      ) : devices.length === 0 ? (
        <div className="px-5 py-8 text-sm text-gray-500">
          No devices configured.{' '}
          <button onClick={() => navigate('/devices')} className="text-blue-400 hover:text-blue-300">Add one →</button>
        </div>
      ) : (
        <div className="divide-y divide-gray-800/50">
          {devices.map(d => {
            const st = d.status ?? 'unknown'
            return (
              <div key={d.id} className="px-5 py-3 flex items-center gap-3 hover:bg-gray-800/30 transition-colors">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[st] ?? STATUS_DOT.unknown}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate">{d.name || d.ip}</p>
                  {d.name && <p className="text-xs text-gray-500">{d.ip}</p>}
                </div>
                <div className="flex-shrink-0 text-right">
                  <p className={`text-xs font-medium capitalize ${STATUS_LABEL[st] ?? STATUS_LABEL.unknown}`}>{st}</p>
                  {d.last_seen && (
                    <p className="text-xs text-gray-600">{fmtTime(d.last_seen)}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Top trap sources ──────────────────────────────────────────────────────────

function TopSources({ sources }: { sources: Array<{ source_ip: string; count: number }> }) {
  const max = Math.max(...sources.map(s => s.count), 1)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800">
        <p className="text-sm font-medium text-white">Top trap sources — 24h</p>
      </div>
      {sources.length === 0 ? (
        <div className="px-5 py-8 text-sm text-gray-500">No trap data</div>
      ) : (
        <div className="divide-y divide-gray-800/50">
          {sources.map((s, i) => (
            <div key={i} className="px-5 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-mono text-white">{s.source_ip}</span>
                <span className="text-xs text-gray-400">{s.count.toLocaleString()}</span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full"
                  style={{ width: `${(s.count / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Recent traps ──────────────────────────────────────────────────────────────

function RecentTraps({ traps }: { traps: Array<{ received_at: string; source_ip: string; trap_oid: string; snmp_version: string }> }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800">
        <p className="text-sm font-medium text-white">Recent traps</p>
      </div>
      {traps.length === 0 ? (
        <div className="px-5 py-8 text-sm text-gray-500">No traps received yet</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="px-5 py-2 text-left text-gray-500 font-normal">Time</th>
              <th className="px-5 py-2 text-left text-gray-500 font-normal">Source</th>
              <th className="px-5 py-2 text-left text-gray-500 font-normal">OID</th>
              <th className="px-5 py-2 text-left text-gray-500 font-normal">Ver</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {traps.map((t, i) => (
              <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                <td className="px-5 py-2 text-gray-400 whitespace-nowrap">{fmtTime(t.received_at)}</td>
                <td className="px-5 py-2 font-mono text-white">{t.source_ip || '—'}</td>
                <td className="px-5 py-2 font-mono text-gray-300 max-w-[200px] truncate" title={t.trap_oid}>{t.trap_oid || '—'}</td>
                <td className="px-5 py-2 text-gray-500">{t.snmp_version || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const EMPTY_DASH: SnmpDashboard = {
  trap_timeline: [], top_sources: [], recent_traps: [],
  active_alerts: 0, traps_24h: 0,
  devices: { total: 0, up: 0, down: 0, unknown: 0 },
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [dash, setDash]       = useState<SnmpDashboard>(EMPTY_DASH)
  const [devices, setDevices] = useState<DeviceWithStatus[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const [d, devs] = await Promise.all([
        api.getSnmpDashboard(),
        api.getSnmpDevices(),
      ])
      setDash(d)
      setDevices(devs as DeviceWithStatus[])
    } catch {}
    finally { setLoading(false) }
  }

  const { tick } = useAutoRefresh()
  useEffect(() => { load() }, [tick])
  useEffect(() => { load() }, [])

  const { devices: devCounts } = dash

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Dashboard</h1>
        <p className="text-xs text-gray-600">Auto-refreshes every 30s</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Devices"
          value={loading ? '…' : devCounts.total}
          sub={devCounts.total > 0 ? `${devCounts.up} up · ${devCounts.down} down · ${devCounts.unknown} unknown` : undefined}
          onClick={() => navigate('/devices')}
        />
        <StatCard
          label="Devices up"
          value={loading ? '…' : devCounts.up}
          sub={devCounts.total > 0 ? `${devCounts.total > 0 ? Math.round((devCounts.up / devCounts.total) * 100) : 0}% reachable` : undefined}
        />
        <StatCard
          label="Traps (24h)"
          value={loading ? '…' : dash.traps_24h.toLocaleString()}
        />
        <StatCard
          label="Active Alerts"
          value={loading ? '…' : dash.active_alerts}
          accent
          onClick={dash.active_alerts > 0 ? () => navigate('/alerts') : undefined}
        />
      </div>

      {/* Trap timeline */}
      <TrapTimeline data={dash.trap_timeline} />

      {/* Device grid + Top sources */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <DeviceGrid devices={devices} loading={loading} />
        <TopSources sources={dash.top_sources} />
      </div>

      {/* Recent traps */}
      <RecentTraps traps={dash.recent_traps} />
    </div>
  )
}
