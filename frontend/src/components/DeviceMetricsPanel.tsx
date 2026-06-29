/**
 * DeviceMetricsPanel — sliding side panel shown when a device is clicked in the Dashboard tree.
 *
 * Shows:
 *  - Device name, IP, status, last seen
 *  - In/Out traffic sparklines (last 1h, rate computed from counters)
 *  - Oper/Admin status badges
 *  - "View Full Metrics →" link to /metrics?device=<id>
 *  - "Create Alert" quick link
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LineChart, Line, ResponsiveContainer, Tooltip, YAxis,
} from 'recharts'
import {
  api, DeviceTreeNode, MetricLatestItem, MetricPoint, OID_META,
} from '../api/client'

// ── Rate computation ──────────────────────────────────────────────────────────

interface RatePoint {
  t: number      // unix ms
  inBps: number | null
  outBps: number | null
}

function computeRates(series: MetricPoint[]): RatePoint[] {
  const byLabel: Record<string, MetricPoint[]> = {}
  for (const p of series) {
    if (!byLabel[p.oid_label]) byLabel[p.oid_label] = []
    byLabel[p.oid_label].push(p)
  }

  const inPts  = byLabel['ifInOctets']  || []
  const outPts = byLabel['ifOutOctets'] || []

  // Build a timestamp-keyed map for alignment
  const timestamps = [...new Set([
    ...inPts.map(p => p.bucket_ts),
    ...outPts.map(p => p.bucket_ts),
  ])].sort()

  const inMap  = Object.fromEntries(inPts.map(p  => [p.bucket_ts, p.max_value]))
  const outMap = Object.fromEntries(outPts.map(p => [p.bucket_ts, p.max_value]))

  const rates: RatePoint[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const t1 = new Date(timestamps[i - 1]).getTime()
    const t2 = new Date(timestamps[i]).getTime()
    const dtSec = (t2 - t1) / 1000
    if (dtSec <= 0) continue

    const in1 = inMap[timestamps[i - 1]]
    const in2 = inMap[timestamps[i]]
    const out1 = outMap[timestamps[i - 1]]
    const out2 = outMap[timestamps[i]]

    // Null on counter reset (negative delta)
    const inBps  = (in1  != null && in2  != null && in2  >= in1)  ? (in2  - in1)  / dtSec : null
    const outBps = (out1 != null && out2 != null && out2 >= out1) ? (out2 - out1) / dtSec : null

    rates.push({ t: t2, inBps, outBps })
  }
  return rates
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtBytes(bps: number | null | undefined): string {
  if (bps == null) return '—'
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`
  return `${bps.toFixed(0)} bps`
}

function fmtRelative(ts: string | null): string {
  if (!ts) return '—'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  const secs = Math.floor((Date.now() - new Date(utc).getTime()) / 1000)
  if (secs < 60)    return `${secs}s ago`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({
  data, dataKey, color,
}: {
  data: RatePoint[]
  dataKey: 'inBps' | 'outBps'
  color: string
}) {
  if (!data.length) {
    return (
      <div className="h-14 flex items-center justify-center text-xs text-gray-600">
        No data
      </div>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={56}>
      <LineChart data={data}>
        <YAxis domain={['auto', 'auto']} hide />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const v = payload[0].value as number | null
            return (
              <div className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white">
                {fmtBytes(v)}
              </div>
            )
          }}
        />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

function StatusBadge({ label, value }: { label: string; value: number | null }) {
  const up = value === 1
  const down = value === 0
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${up ? 'bg-green-500' : down ? 'bg-red-500' : 'bg-gray-500'}`} />
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-xs font-medium ${up ? 'text-green-400' : down ? 'text-red-400' : 'text-gray-500'}`}>
        {value == null ? '—' : up ? 'Up' : 'Down'}
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  device: DeviceTreeNode | null
  onClose: () => void
}

export default function DeviceMetricsPanel({ device, onClose }: Props) {
  const navigate = useNavigate()
  const [latest, setLatest]   = useState<MetricLatestItem[]>([])
  const [rates, setRates]     = useState<RatePoint[]>([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!device) { setLatest([]); setRates([]); return }

    setLoading(true)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    Promise.all([
      api.getDeviceMetricsLatest(device.id),
      api.getDeviceMetricsHistory(device.id, { since: '1h', oid_labels: 'ifInOctets,ifOutOctets' }),
    ])
      .then(([lat, hist]) => {
        if (ctrl.signal.aborted) return
        setLatest(lat)
        setRates(computeRates(hist.series))
      })
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })

    return () => ctrl.abort()
  }, [device?.id])

  if (!device) return null

  const latestMap = Object.fromEntries(latest.map(l => [l.oid_label, l.value_numeric]))
  const lastInRate  = rates.length ? rates[rates.length - 1].inBps  : null
  const lastOutRate = rates.length ? rates[rates.length - 1].outBps : null

  const statusColor =
    !device.enabled  ? 'text-gray-500'  :
    device.status === 'up'   ? 'text-green-400' :
    device.status === 'down' ? 'text-red-400'   :
    'text-gray-400'

  const dotColor =
    !device.enabled  ? 'bg-gray-600'  :
    device.status === 'up'   ? 'bg-green-500' :
    device.status === 'down' ? 'bg-red-500'   :
    'bg-gray-500'

  return (
    <div className="fixed inset-y-0 right-0 w-80 bg-gray-950 border-l border-gray-800 shadow-2xl z-40 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 bg-gray-900">
        <span className="relative flex-shrink-0">
          <span className={`w-2.5 h-2.5 rounded-full block ${dotColor}`} />
          {device.status === 'down' && (
            <span className="absolute inset-0 rounded-full animate-ping bg-red-500 opacity-60" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{device.name}</p>
          <p className="text-xs text-gray-500 font-mono">{device.ip}</p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Status row */}
        <div className="flex items-center justify-between">
          <span className={`text-sm font-bold uppercase tracking-wide ${statusColor}`}>
            {device.enabled ? device.status : 'Disabled'}
          </span>
          <span className="text-xs text-gray-500">{fmtRelative(device.last_seen)}</span>
        </div>

        {device.device_type && (
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
              {device.device_type.replace('_', ' ')}
            </span>
            {device.ha_role && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-700/40">
                {device.ha_role}
              </span>
            )}
          </div>
        )}

        {/* Interface status */}
        {(latestMap['ifOperStatusMetric'] != null || latestMap['ifAdminStatusMetric'] != null || latestMap['Status'] != null) && (
          <div className="bg-gray-900 rounded-lg p-3 space-y-2 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Interface Status</p>
            {latestMap['ifOperStatusMetric'] != null && (
              <StatusBadge label="Oper" value={latestMap['ifOperStatusMetric']} />
            )}
            {latestMap['ifAdminStatusMetric'] != null && (
              <StatusBadge label="Admin" value={latestMap['ifAdminStatusMetric']} />
            )}
            {latestMap['Status'] != null && (
              <StatusBadge label="Status" value={latestMap['Status']} />
            )}
          </div>
        )}

        {/* Traffic sparklines */}
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800 space-y-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Traffic — last 1h</p>

          {loading ? (
            <div className="h-14 flex items-center justify-center text-xs text-gray-600 animate-pulse">
              Loading…
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-cyan-400">↓ In</span>
                  <span className="text-xs font-mono text-white">{fmtBytes(lastInRate)}</span>
                </div>
                <Sparkline data={rates} dataKey="inBps" color="#22d3ee" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-violet-400">↑ Out</span>
                  <span className="text-xs font-mono text-white">{fmtBytes(lastOutRate)}</span>
                </div>
                <Sparkline data={rates} dataKey="outBps" color="#a78bfa" />
              </div>
            </>
          )}
        </div>

        {/* Latest values summary */}
        {latest.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">Latest Values</p>
            <div className="space-y-1">
              {latest
                .filter(l => !['ifInOctets', 'ifOutOctets', 'ifOperStatusMetric', 'ifAdminStatusMetric', 'Status'].includes(l.oid_label))
                .map(l => {
                  const meta = OID_META[l.oid_label]
                  return (
                    <div key={l.oid_label} className="flex items-center justify-between">
                      <span className="text-xs text-gray-400">{meta?.label ?? l.oid_label}</span>
                      <span className="text-xs font-mono text-gray-200">
                        {l.value_numeric != null ? l.value_numeric.toLocaleString() : l.value ?? '—'}
                      </span>
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="border-t border-gray-800 p-3 space-y-2">
        <button
          onClick={() => navigate(`/metrics?device=${device.id}`)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          View Full Metrics →
        </button>
        <button
          onClick={() => navigate(`/alerts?new=metric_threshold&device_id=${device.id}&device_name=${encodeURIComponent(device.name)}`)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors border border-gray-700"
        >
          + Create Alert Rule
        </button>
      </div>
    </div>
  )
}
