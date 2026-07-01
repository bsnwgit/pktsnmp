/**
 * MetricsPage — full SNMP metrics dashboard.
 *
 * Three navigation layers:
 *   Overview  → all device cards (uniform layout; no-data = visible, dimmed)
 *   Device    → device detail with interface sidebar + metric sections
 *   Interface → per-port IF-MIB charts filtered by interface_label (ifDescr)
 *
 * All metric sections always render — empty state visible, not hidden.
 */
import {
  useEffect, useState, useCallback, useRef, useMemo,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ComposedChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import {
  api,
  DeviceMetricsCard, DeviceInterface, MetricsHistoryResponse, MetricPoint,
  OID_META, TimeRange,
} from '../api/client'

// ── Constants ──────────────────────────────────────────────────────────────────

const DEVICE_TYPE_ICONS: Record<string, string> = {
  firewall:      '🔥',
  switch:        '🔀',
  wap:           '📡',
  wlc:           '🗼',
  router:        '🌐',
  iot:           '🔌',
  ups:           '🔋',
  server:        '🖥️',
  storage:       '💾',
  pdu:           '⚡',
  camera:        '📷',
  load_balancer: '⚖️',
  vpn:           '🔒',
  printer:       '🖨️',
  other:         '📦',
  '':            '📦',
}

const STATUS_COLOR: Record<string, string> = {
  up:      'bg-green-500',
  down:    'bg-red-500',
  unknown: 'bg-gray-400',
}

const STATUS_RING: Record<string, string> = {
  up:      'ring-green-500/30',
  down:    'ring-red-500/30',
  unknown: 'ring-gray-400/30',
}

// OID groups — always rendered even if no data in the window
const OID_GROUPS = {
  traffic: {
    label: 'Traffic',
    oids:  ['ifInOctets', 'ifOutOctets'] as const,
    color: ['#3b82f6', '#8b5cf6'],
    unit:  'bps',
    isRate: true,
  },
  packets: {
    label: 'Packets',
    oids:  ['ifInUcastPkts', 'ifOutUcastPkts'] as const,
    color: ['#06b6d4', '#f59e0b'],
    unit:  'pkt/s',
    isRate: true,
  },
  errors: {
    label: 'Errors & Discards',
    oids:  ['ifInErrors', 'ifOutErrors', 'ifInDiscards', 'ifOutDiscards'] as const,
    color: ['#ef4444', '#f97316', '#eab308', '#84cc16'],
    unit:  '/s',
    isRate: true,
  },
  system: {
    label: 'System Resources',
    oids:  ['hrProcessorLoad', 'hrMemorySize', 'hrStorageUsed'] as const,
    color: ['#10b981', '#6366f1', '#f43f5e'],
    unit:  '',
    isRate: false,
  },
  ip: {
    label: 'IP / Protocol',
    oids:  ['ipInReceives', 'ipOutRequests', 'tcpCurrEstab', 'udpInDatagrams'] as const,
    color: ['#0ea5e9', '#a855f7', '#f59e0b', '#10b981'],
    unit:  '/s',
    isRate: true,
  },
  // PAN-OS vendor-specific groups
  panTraffic: {
    label: 'PAN-OS Interface Traffic',
    oids:  ['panIfInBytes', 'panIfOutBytes'] as const,
    color: ['#3b82f6', '#8b5cf6'],
    unit:  'bps',
    isRate: true,
  },
  panPackets: {
    label: 'PAN-OS Interface Packets',
    oids:  ['panIfInPkts', 'panIfOutPkts', 'panIfInDropPkts', 'panIfOutDropPkts'] as const,
    color: ['#06b6d4', '#f59e0b', '#ef4444', '#f97316'],
    unit:  'pkt/s',
    isRate: true,
  },
  panFirewall: {
    label: 'PAN-OS Firewall Health',
    oids:  ['panSysCpuUtilMgmt', 'panSysCpuUtilDataPlane', 'panSessionUtilization', 'panSessionActive'] as const,
    color: ['#10b981', '#6366f1', '#f59e0b', '#3b82f6'],
    unit:  '',
    isRate: false,
  },
} as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, unit = ''): string {
  if (n === null || n === undefined) return '—'
  if (unit === 'bps') {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Gbps`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} Kbps`
    return `${n.toFixed(0)} bps`
  }
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(n < 10 ? 2 : 0)
}

function fmtUptime(sec: number | null | undefined): string {
  if (!sec) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function tsShort(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Compute bits/sec rates from adjacent counter rows */
function computeRates(
  series: MetricPoint[],
  oid: string,
): Array<{ bucket_ts: string; rate: number | null }> {
  const rows = series
    .filter(r => r.oid_label === oid)
    .sort((a, b) => a.bucket_ts.localeCompare(b.bucket_ts))
  return rows.map((row, i) => {
    if (i === 0) return { bucket_ts: row.bucket_ts, rate: null }
    const prev = rows[i - 1]
    if (prev.max_value === null || row.max_value === null) return { bucket_ts: row.bucket_ts, rate: null }
    const dt = (new Date(row.bucket_ts).getTime() - new Date(prev.bucket_ts).getTime()) / 1000
    if (dt <= 0) return { bucket_ts: row.bucket_ts, rate: null }
    const delta = row.max_value - prev.max_value
    if (delta < 0) return { bucket_ts: row.bucket_ts, rate: null } // counter reset
    return { bucket_ts: row.bucket_ts, rate: (delta * 8) / dt }    // bits/sec
  })
}

/** Build unified timestamp-keyed timeline for a group of OIDs */
function buildTimeline(
  series: MetricPoint[],
  oids: readonly string[],
  isRate: boolean,
): Record<string, number | null>[] {
  const byOid: Record<string, Map<string, number | null>> = {}
  for (const oid of oids) {
    if (isRate && OID_META[oid]?.isCounter) {
      const rates = computeRates(series, oid)
      byOid[oid] = new Map(rates.map(r => [r.bucket_ts, r.rate]))
    } else {
      byOid[oid] = new Map(
        series.filter(r => r.oid_label === oid).map(r => [r.bucket_ts, r.avg_value])
      )
    }
  }
  const relevant = series.filter(r => oids.includes(r.oid_label))
  const allTs = [...new Set(relevant.map(r => r.bucket_ts))].sort()
  return allTs.map(ts => {
    const row: Record<string, number | null> = { ts: new Date(ts).getTime() }
    for (const oid of oids) row[oid] = byOid[oid]?.get(ts) ?? null
    return row
  })
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLOR[status] ?? 'bg-gray-400'}`} />
  )
}

interface ChartSectionProps {
  title: string
  data: Record<string, number | null>[]
  oids: readonly string[]
  colors: readonly string[]
  unit: string
  alertEvents?: MetricsHistoryResponse['alert_events']
}

function ChartSection({ title, data, oids, colors, unit, alertEvents = [] }: ChartSectionProps) {
  const hasData = data.length > 0 && data.some(r => oids.some(o => r[o] !== null))
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        {!hasData && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-500 font-mono">no data</span>
        )}
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={160}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={tsShort}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={v => fmt(v, unit)}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip
              contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 11 }}
              labelFormatter={v => new Date(v as number).toLocaleString()}
              formatter={(val: number, name: string) => [fmt(val, unit), OID_META[name]?.label ?? name]}
            />
            <Legend
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: '#9ca3af' }}
              formatter={(name: string) => OID_META[name]?.label ?? name}
            />
            {oids.map((oid, i) => (
              <Line
                key={oid}
                type="monotone"
                dataKey={oid}
                stroke={colors[i] ?? '#6b7280'}
                dot={false}
                strokeWidth={1.5}
                connectNulls={false}
              />
            ))}
            {alertEvents.map(ae => (
              <ReferenceLine
                key={ae.id}
                x={new Date(ae.fired_at).getTime()}
                stroke={ae.severity === 'critical' ? '#ef4444' : ae.severity === 'warning' ? '#f59e0b' : '#3b82f6'}
                strokeDasharray="4 2"
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-40 flex items-center justify-center text-sm text-gray-600 border border-dashed border-gray-800 rounded-lg">
          No data in this time range
        </div>
      )}
    </div>
  )
}

function DeviceCard({ card, onClick }: { card: DeviceMetricsCard; onClick: () => void }) {
  const { device, latest, has_data } = card
  const icon   = DEVICE_TYPE_ICONS[device.device_type] ?? '📦'
  const status = device.status || 'unknown'

  const inOctets  = latest['ifInOctets']?.value_numeric
  const outOctets = latest['ifOutOctets']?.value_numeric
  const inErrors  = latest['ifInErrors']?.value_numeric
  const outErrors = latest['ifOutErrors']?.value_numeric
  const uptime    = latest['sysUpTime']?.value_numeric
  const cpu       = latest['hrProcessorLoad']?.value_numeric
  const lastSeen  = device.last_seen
    ? new Date(device.last_seen).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : null

  return (
    <button
      onClick={onClick}
      className={[
        'text-left w-full rounded-xl border p-4 transition-all duration-150',
        'hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-900/10',
        'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
        'ring-2 ring-transparent',
        STATUS_RING[status] ?? 'ring-gray-400/30',
        has_data
          ? 'bg-gray-900 border-gray-800'
          : 'bg-gray-900/50 border-gray-800/50 opacity-60',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xl flex-shrink-0">{icon}</span>
          <div className="min-w-0">
            <p className="font-semibold text-sm text-gray-100 truncate">{device.name}</p>
            <p className="text-xs text-gray-500 font-mono">{device.ip}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <StatusDot status={status} />
          <span className="text-xs text-gray-400 capitalize">{status}</span>
        </div>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mb-3">
        {device.org  && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-300">{device.org}</span>}
        {device.site && <span className="text-xs px-1.5 py-0.5 rounded bg-purple-900/30 text-purple-300">{device.site}</span>}
        {device.device_type && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 capitalize">
            {device.device_type.replace('_', ' ')}
          </span>
        )}
      </div>

      {/* Metrics */}
      {has_data ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-800/60 rounded-lg p-2">
              <p className="text-xs text-gray-500 mb-0.5">↓ In</p>
              <p className="text-sm font-mono font-medium text-blue-300">
                {inOctets != null ? fmt(inOctets * 8, 'bps') : '—'}
              </p>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-2">
              <p className="text-xs text-gray-500 mb-0.5">↑ Out</p>
              <p className="text-sm font-mono font-medium text-purple-300">
                {outOctets != null ? fmt(outOctets * 8, 'bps') : '—'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 text-xs text-center">
            <div>
              <p className="text-gray-500">Errors</p>
              <p className={`font-mono ${(inErrors ?? 0) + (outErrors ?? 0) > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {((inErrors ?? 0) + (outErrors ?? 0)).toFixed(0)}
              </p>
            </div>
            <div>
              <p className="text-gray-500">Uptime</p>
              <p className="text-gray-300 font-mono">{fmtUptime(uptime)}</p>
            </div>
            {cpu != null ? (
              <div>
                <p className="text-gray-500">CPU</p>
                <p className={`font-mono ${cpu > 80 ? 'text-red-400' : cpu > 60 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {cpu.toFixed(0)}%
                </p>
              </div>
            ) : (
              <div>
                <p className="text-gray-500">Seen</p>
                <p className="text-gray-500 truncate">{lastSeen ?? '—'}</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="h-14 flex items-center justify-center text-xs text-gray-600 border border-dashed border-gray-800 rounded-lg">
          No SNMP data received
        </div>
      )}

      <p className="text-xs text-blue-400/50 text-right mt-2">View metrics →</p>
    </button>
  )
}

function IfaceRow({
  iface, selected, onClick,
}: {
  iface: DeviceInterface | null
  selected: boolean
  onClick: () => void
}) {
  const base = `w-full text-left px-3 py-2 rounded-lg text-sm transition-colors`
  const cls  = selected
    ? `${base} bg-blue-600/20 text-blue-300 border border-blue-500/30`
    : `${base} text-gray-400 hover:bg-gray-800/60`

  if (!iface) {
    return <button onClick={onClick} className={cls}>All interfaces</button>
  }

  const dot = iface.oper_status === 'up'
    ? 'bg-green-500'
    : iface.oper_status === 'down'
    ? 'bg-red-500'
    : 'bg-gray-500'

  return (
    <button onClick={onClick} className={cls}>
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
        <span className="truncate font-medium">{iface.name}</span>
      </div>
      {(iface.speed_mbps || iface.admin_status === 'down') && (
        <p className="text-xs text-gray-600 pl-3.5 mt-0.5">
          {iface.speed_mbps
            ? (iface.speed_mbps >= 1000
                ? `${(iface.speed_mbps / 1000).toFixed(0)} Gbps`
                : `${iface.speed_mbps} Mbps`)
            : ''}
          {iface.admin_status === 'down' ? ' · disabled' : ''}
        </p>
      )}
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

type ViewMode = 'overview' | 'device' | 'interface'
const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1h' }, { value: '6h', label: '6h' },
  { value: '24h', label: '24h' }, { value: '7d', label: '7d' },
]

export default function MetricsPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [viewMode, setViewMode]           = useState<ViewMode>('overview')
  const [selectedDeviceId, setSelDev]     = useState<number | null>(null)
  const [selectedIfLabel, setSelIf]       = useState<string | null>(null)

  const [overviewCards, setOverview]      = useState<DeviceMetricsCard[]>([])
  const [overviewLoading, setOvLoad]      = useState(true)
  const [interfaces, setInterfaces]       = useState<DeviceInterface[]>([])
  const [ifLoading, setIfLoad]            = useState(false)
  const [history, setHistory]             = useState<MetricsHistoryResponse | null>(null)
  const [histLoading, setHistLoad]        = useState(false)

  const [since, setSince]                 = useState<TimeRange>('1h')
  const [searchQ, setSearchQ]             = useState('')
  const [typeFilter, setTypeFilter]       = useState('')
  const [orgFilter, setOrgFilter]         = useState('')
  const histAbort = useRef<AbortController | null>(null)

  // URL sync on mount
  useEffect(() => {
    const view    = searchParams.get('view') as ViewMode | null
    const devId   = searchParams.get('device')
    const ifLabel = searchParams.get('iflabel')
    const rng     = searchParams.get('since') as TimeRange | null
    if (rng && ['1h','6h','24h','7d'].includes(rng)) setSince(rng)
    if (devId) {
      setSelDev(Number(devId))
      if (view === 'interface' && ifLabel) { setSelIf(ifLabel); setViewMode('interface') }
      else setViewMode('device')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pushUrl = useCallback((mode: ViewMode, devId?: number, ifLabel?: string) => {
    const p: Record<string, string> = { view: mode, since }
    if (devId)   p.device   = String(devId)
    if (ifLabel) p.iflabel  = ifLabel
    setSearchParams(p, { replace: true })
  }, [since, setSearchParams])

  // Load overview
  useEffect(() => {
    setOvLoad(true)
    api.getMetricsOverview()
      .then(setOverview)
      .catch(console.error)
      .finally(() => setOvLoad(false))
  }, [])

  // Load interfaces when a device is selected
  useEffect(() => {
    if (!selectedDeviceId || viewMode === 'overview') return
    setIfLoad(true)
    api.getDeviceInterfaces(selectedDeviceId)
      .then(setInterfaces)
      .catch(console.error)
      .finally(() => setIfLoad(false))
  }, [selectedDeviceId, viewMode])

  // Load history on device/interface/time change
  useEffect(() => {
    if (!selectedDeviceId || viewMode === 'overview') return
    histAbort.current?.abort()
    histAbort.current = new AbortController()
    setHistLoad(true)
    api.getDeviceMetricsHistory(selectedDeviceId, {
      since,
      interface_label: selectedIfLabel ?? undefined,
    })
      .then(setHistory)
      .catch(e => { if (e?.name !== 'AbortError') console.error(e) })
      .finally(() => setHistLoad(false))
  }, [selectedDeviceId, selectedIfLabel, since, viewMode])

  const goDevice = useCallback((id: number) => {
    setSelDev(id); setSelIf(null); setViewMode('device'); pushUrl('device', id)
  }, [pushUrl])

  const goInterface = useCallback((label: string) => {
    setSelIf(label); setViewMode('interface'); pushUrl('interface', selectedDeviceId!, label)
  }, [selectedDeviceId, pushUrl])

  const goOverview = useCallback(() => {
    setViewMode('overview'); setSelDev(null); setSelIf(null)
    setHistory(null); setInterfaces([])
    setSearchParams({}, { replace: true })
  }, [setSearchParams])

  const goBackToDevice = useCallback(() => {
    setSelIf(null); setViewMode('device'); pushUrl('device', selectedDeviceId!)
  }, [selectedDeviceId, pushUrl])

  const selectedCard  = useMemo(() => overviewCards.find(c => c.device.id === selectedDeviceId) ?? null, [overviewCards, selectedDeviceId])
  const selectedIface = useMemo(() => interfaces.find(i => i.interface_label === selectedIfLabel) ?? null, [interfaces, selectedIfLabel])

  const filteredCards = useMemo(() => overviewCards.filter(c => {
    if (searchQ && !c.device.name.toLowerCase().includes(searchQ.toLowerCase()) && !c.device.ip.includes(searchQ)) return false
    if (typeFilter && c.device.device_type !== typeFilter) return false
    if (orgFilter  && c.device.org !== orgFilter) return false
    return true
  }), [overviewCards, searchQ, typeFilter, orgFilter])

  const allTypes = useMemo(() => [...new Set(overviewCards.map(c => c.device.device_type).filter(Boolean))].sort(), [overviewCards])
  const allOrgs  = useMemo(() => [...new Set(overviewCards.map(c => c.device.org).filter(Boolean))].sort(), [overviewCards])

  const counts = useMemo(() => ({
    total:  overviewCards.length,
    up:     overviewCards.filter(c => c.device.status === 'up').length,
    down:   overviewCards.filter(c => c.device.status === 'down').length,
    noData: overviewCards.filter(c => !c.has_data).length,
  }), [overviewCards])

  const series = history?.series ?? []
  const chartData = useMemo(() => ({
    traffic:    buildTimeline(series, OID_GROUPS.traffic.oids,    true),
    packets:    buildTimeline(series, OID_GROUPS.packets.oids,    true),
    errors:     buildTimeline(series, OID_GROUPS.errors.oids,     true),
    system:     buildTimeline(series, OID_GROUPS.system.oids,     false),
    ip:         buildTimeline(series, OID_GROUPS.ip.oids,         true),
    panTraffic: buildTimeline(series, OID_GROUPS.panTraffic.oids, true),
    panPackets: buildTimeline(series, OID_GROUPS.panPackets.oids, true),
    panFirewall:buildTimeline(series, OID_GROUPS.panFirewall.oids,false),
  }), [series])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">

      {/* Top bar */}
      <div className="sticky top-0 z-20 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-sm min-w-0">
            <button onClick={goOverview} className="text-blue-400 hover:text-blue-300 font-medium">
              Metrics
            </button>
            {selectedCard && <>
              <span className="text-gray-600">/</span>
              {viewMode === 'device'
                ? <span className="text-gray-200 font-medium truncate max-w-[200px]">{selectedCard.device.name}</span>
                : <button onClick={goBackToDevice} className="text-blue-400 hover:text-blue-300 truncate max-w-[160px]">{selectedCard.device.name}</button>
              }
            </>}
            {selectedIface && <>
              <span className="text-gray-600">/</span>
              <span className="text-gray-200 font-medium truncate max-w-[160px]">{selectedIface.name}</span>
            </>}
          </nav>

          <div className="flex-1" />

          {viewMode !== 'overview' && (
            <div className="flex gap-1">
              {TIME_RANGES.map(r => (
                <button key={r.value} onClick={() => setSince(r.value)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    since === r.value ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}>
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {viewMode !== 'overview' && selectedDeviceId && (
            <button
              onClick={() => api.downloadDeviceMetricsCsv(selectedDeviceId, since)}
              className="px-3 py-1 rounded-md text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
            >
              ↓ CSV
            </button>
          )}

          {histLoading && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Loading…
            </span>
          )}
        </div>
      </div>

      {/* ── OVERVIEW ── */}
      {viewMode === 'overview' && (
        <div className="px-6 py-6 space-y-5">
          {/* Summary tiles */}
          {!overviewLoading && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total',   value: counts.total,  color: 'text-gray-200' },
                { label: 'Up',      value: counts.up,     color: 'text-green-400' },
                { label: 'Down',    value: counts.down,   color: 'text-red-400' },
                { label: 'No data', value: counts.noData, color: 'text-gray-500' },
              ].map(s => (
                <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            <input
              type="text" placeholder="Search devices…" value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              className="flex-1 min-w-[180px] max-w-xs bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40">
              <option value="">All types</option>
              {allTypes.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
            {allOrgs.length > 1 && (
              <select value={orgFilter} onChange={e => setOrgFilter(e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40">
                <option value="">All orgs</option>
                {allOrgs.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
          </div>

          {/* Card grid */}
          {overviewLoading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="animate-spin w-10 h-10 text-blue-500" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-95" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <span className="text-gray-400 font-medium tracking-wide">Loading devices…</span>
            </div>
          ) : filteredCards.length === 0 ? (
            <div className="text-center py-16 text-gray-600">
              {overviewCards.length === 0 ? 'No devices registered' : 'No devices match filters'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredCards.map(card => (
                <DeviceCard key={card.device.id} card={card} onClick={() => goDevice(card.device.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── DEVICE / INTERFACE ── */}
      {(viewMode === 'device' || viewMode === 'interface') && selectedCard && (
        <div className="flex overflow-hidden" style={{ height: 'calc(100vh - 57px)' }}>

          {/* Interface sidebar */}
          <aside className="w-56 flex-shrink-0 border-r border-gray-800 bg-gray-950 flex flex-col">
            {/* Device mini-header */}
            <div className="p-3 border-b border-gray-800">
              <div className="flex items-center gap-2 mb-1">
                <span>{DEVICE_TYPE_ICONS[selectedCard.device.device_type] ?? '📦'}</span>
                <p className="font-semibold text-xs text-gray-200 truncate">{selectedCard.device.name}</p>
              </div>
              <p className="text-xs font-mono text-gray-500">{selectedCard.device.ip}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <StatusDot status={selectedCard.device.status} />
                <span className="text-xs text-gray-500 capitalize">{selectedCard.device.status}</span>
              </div>
            </div>

            {/* Interface list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              <IfaceRow iface={null} selected={selectedIfLabel === null}
                onClick={() => { setSelIf(null); setViewMode('device'); pushUrl('device', selectedDeviceId!) }}
              />
              {ifLoading && (
                <div className="flex items-center gap-2 px-3 py-2">
                  <svg className="animate-spin w-4 h-4 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span className="text-xs text-gray-400">Loading interfaces…</span>
                </div>
              )}
              {!ifLoading && interfaces.length === 0 && (
                <p className="text-xs text-gray-600 px-3 py-2">No interface data available</p>
              )}
              {interfaces.map(iface => (
                <IfaceRow key={iface.interface_label} iface={iface}
                  selected={selectedIfLabel === iface.interface_label}
                  onClick={() => goInterface(iface.interface_label)}
                />
              ))}
            </div>
          </aside>

          {/* Main metric area */}
          <main className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

            {/* Header card */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <div className="flex items-start flex-wrap gap-4">
                {selectedIface ? (
                  <>
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Interface</p>
                      <p className="font-semibold text-gray-100">{selectedIface.name}</p>
                      {selectedIface.if_type && (
                        <p className="text-xs text-gray-500">Type: {selectedIface.if_type}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Status</p>
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={selectedIface.oper_status} />
                        <span className="text-sm capitalize">{selectedIface.oper_status}</span>
                        {selectedIface.admin_status === 'down' && (
                          <span className="text-xs text-orange-400 ml-1">(admin down)</span>
                        )}
                      </div>
                    </div>
                    {selectedIface.speed_mbps != null && (
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Speed</p>
                        <p className="text-sm text-gray-200">
                          {selectedIface.speed_mbps >= 1000
                            ? `${(selectedIface.speed_mbps / 1000).toFixed(0)} Gbps`
                            : `${selectedIface.speed_mbps} Mbps`}
                        </p>
                      </div>
                    )}
                    {selectedIface.mac && (
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">MAC</p>
                        <p className="text-xs font-mono text-gray-400">{selectedIface.mac}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Device</p>
                      <p className="font-semibold text-gray-100">{selectedCard.device.name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">IP</p>
                      <p className="text-sm font-mono text-gray-300">{selectedCard.device.ip}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Status</p>
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={selectedCard.device.status} />
                        <span className="text-sm capitalize">{selectedCard.device.status}</span>
                      </div>
                    </div>
                    {selectedCard.latest['sysUpTime']?.value_numeric != null && (
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Uptime</p>
                        <p className="text-sm">{fmtUptime(selectedCard.latest['sysUpTime'].value_numeric)}</p>
                      </div>
                    )}
                    {selectedCard.latest['hrProcessorLoad']?.value_numeric != null && (
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">CPU</p>
                        <p className="text-sm">{selectedCard.latest['hrProcessorLoad'].value_numeric.toFixed(0)}%</p>
                      </div>
                    )}
                    {selectedCard.device.org && (
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Org / Site</p>
                        <p className="text-sm text-gray-300">
                          {selectedCard.device.org}{selectedCard.device.site ? ` · ${selectedCard.device.site}` : ''}
                        </p>
                      </div>
                    )}
                    {!selectedCard.has_data && (
                      <div className="flex items-center">
                        <span className="px-2 py-1 rounded bg-yellow-900/30 text-yellow-300 text-xs border border-yellow-700/30">
                          ⚠ No SNMP data received for this device
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Metric sections — always rendered, show empty state if no data */}
            <ChartSection
              title="Traffic (bits/sec)"
              data={chartData.traffic}
              oids={OID_GROUPS.traffic.oids}
              colors={OID_GROUPS.traffic.color}
              unit="bps"
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="Packets (per sec)"
              data={chartData.packets}
              oids={OID_GROUPS.packets.oids}
              colors={OID_GROUPS.packets.color}
              unit="pkt/s"
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="Errors & Discards (per sec)"
              data={chartData.errors}
              oids={OID_GROUPS.errors.oids}
              colors={OID_GROUPS.errors.color}
              unit="/s"
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="System Resources (CPU %, Memory, Storage)"
              data={chartData.system}
              oids={OID_GROUPS.system.oids}
              colors={OID_GROUPS.system.color}
              unit=""
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="IP / Protocol (receives, requests, TCP sessions, UDP)"
              data={chartData.ip}
              oids={OID_GROUPS.ip.oids}
              colors={OID_GROUPS.ip.color}
              unit="/s"
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="PAN-OS Interface Traffic (bits/sec)"
              data={chartData.panTraffic}
              oids={OID_GROUPS.panTraffic.oids}
              colors={OID_GROUPS.panTraffic.color}
              unit="bps"
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="PAN-OS Interface Packets (per sec)"
              data={chartData.panPackets}
              oids={OID_GROUPS.panPackets.oids}
              colors={OID_GROUPS.panPackets.color}
              unit="pkt/s"
              alertEvents={history?.alert_events}
            />
            <ChartSection
              title="PAN-OS Firewall Health (CPU %, Sessions)"
              data={chartData.panFirewall}
              oids={OID_GROUPS.panFirewall.oids}
              colors={OID_GROUPS.panFirewall.color}
              unit=""
              alertEvents={history?.alert_events}
            />

            {/* Alert event log */}
            {(history?.alert_events?.length ?? 0) > 0 && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-3">Alert Events ({history!.alert_events.length})</h3>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {history!.alert_events.map(ae => (
                    <div key={ae.id} className="flex items-start gap-3 text-xs">
                      <span className={`flex-shrink-0 font-medium mt-0.5 ${ae.severity === 'critical' ? 'text-red-400' : ae.severity === 'warning' ? 'text-yellow-400' : 'text-blue-400'}`}>
                        {ae.severity.toUpperCase()}
                      </span>
                      <span className="text-gray-400 font-mono flex-shrink-0">{new Date(ae.fired_at).toLocaleString()}</span>
                      <span className="text-gray-300">{ae.rule_name} — {ae.message}</span>
                      {ae.resolved_at && <span className="text-green-600 ml-auto flex-shrink-0">resolved</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trap event log */}
            {(history?.trap_events?.length ?? 0) > 0 && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-3">Trap Events ({history!.trap_events.length})</h3>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {history!.trap_events.map(te => (
                    <div key={te.id} className="flex items-center gap-3 text-xs">
                      <span className="text-yellow-500">⚡</span>
                      <span className="text-gray-400 font-mono flex-shrink-0">{new Date(te.received_at).toLocaleString()}</span>
                      <span className="text-gray-300 font-mono">{te.trap_oid ?? 'unknown OID'}</span>
                      {te.source_ip && <span className="text-gray-600">{te.source_ip}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </main>
        </div>
      )}

    </div>
  )
}
