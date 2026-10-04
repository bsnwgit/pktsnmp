import { useEffect, useState, type ReactNode } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { api, DashboardCharts } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import { axisProps, tooltipProps, gridProps, INSTRUMENT, InstrumentFrame, InstrumentHead } from './instrument'

const WINDOWS = [
  { hours: 1,   label: '1h' },
  { hours: 6,   label: '6h' },
  { hours: 24,  label: '24h' },
  { hours: 168, label: '7d' },
]
const CHART_H = 180

// Alarm hues are the suite's only high-chroma colours, so severity reads the
// same here as on the Alerts page.
const SEVERITY: Array<{ key: 'critical' | 'warning' | 'info'; name: string; color: string }> = [
  { key: 'critical', name: 'Critical', color: '#ff6b5e' },
  { key: 'warning',  name: 'Warning',  color: '#f3c265' },
  { key: 'info',     name: 'Info',     color: INSTRUMENT.ice },
]

function timeTick(spanMs: number) {
  const withDate = spanMs > 24 * 3600 * 1000
  return (ms: number) => new Date(ms).toLocaleString([], withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' })
}

function Empty({ msg, height = 90 }: { msg: string; height?: number }) {
  return <div className="grid place-items-center text-center f-lbl px-4" style={{ height }}>{msg}</div>
}

function Panel({ title, chip, children }: { title: string; chip?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <InstrumentHead right={chip ? <span className="f-lbl">{chip}</span> : undefined}>{title}</InstrumentHead>
      <div className="f-panel p-3">{children}</div>
    </section>
  )
}

/** Horizontal bars: warm past a threshold so the entry worth a look stands out
 *  without the whole list shouting. `pct` marks a 0–100 value; otherwise bars
 *  scale to the largest row. */
function BarList({ rows, empty, pct, onPick }: {
  rows: Array<{ key: string; label: string; value: number }>
  empty: string
  pct?: boolean
  onPick?: (key: string) => void
}) {
  if (!rows.length) return <Empty msg={empty} />
  const max = Math.max(1, ...rows.map(r => r.value))
  return (
    <ul className="space-y-2.5">
      {rows.map(r => {
        const width = pct ? r.value : (r.value / max) * 100
        const tone = pct && r.value >= 90 ? 'bg-red-500' : pct && r.value >= 75 ? 'bg-yellow-400' : 'bg-cyan-400'
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-xs text-white truncate group-hover:underline">{r.label}</span>
              <span className="font-mono text-xs text-white shrink-0">
                {pct ? `${Math.round(r.value)}%` : r.value.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 bg-gray-800">
              <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, width))}%` }} />
            </div>
          </>
        )
        return (
          <li key={r.key}>
            {onPick
              ? <button type="button" onClick={() => onPick(r.key)} className="block w-full text-left group">{body}</button>
              : <div className="group">{body}</div>}
          </li>
        )
      })}
    </ul>
  )
}

function AlertTrend({ rows, spanMs }: { rows: DashboardCharts['alert_trend']; spanMs: number }) {
  const totals = SEVERITY.map(s => ({ ...s, total: rows.reduce((n, r) => n + r[s.key], 0) }))
  if (totals.every(s => s.total === 0)) return <Empty msg="No alerts fired in this window" height={CHART_H} />
  return (
    <div>
      <InstrumentFrame height={CHART_H}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 10, right: 10, bottom: 4, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                   tickFormatter={timeTick(spanMs)} minTickGap={48} {...axisProps} />
            <YAxis width={32} allowDecimals={false} {...axisProps} />
            <Tooltip
              contentStyle={tooltipProps.contentStyle}
              labelStyle={tooltipProps.labelStyle}
              cursor={tooltipProps.cursor}
              labelFormatter={(v: number) => new Date(v).toLocaleString()}
              formatter={(v: number, key: string) => [v, SEVERITY.find(s => s.key === key)?.name ?? key]}
            />
            {SEVERITY.map(s => (
              <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </InstrumentFrame>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
        {totals.map(s => (
          <span key={s.key} className="flex items-center gap-1.5 font-mono text-[10px] text-gray-400">
            <span className="w-2 h-2" style={{ background: s.color }} />
            {s.name} <span className="text-white">{s.total}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function FleetCharts({ onPickDevice }: { onPickDevice: (id: number) => void }) {
  const [hours, setHours] = useState(24)
  const [data, setData]   = useState<DashboardCharts | null>(null)
  const [failed, setFailed] = useState(false)

  const load = async () => {
    try { setData(await api.getDashboardCharts(hours)); setFailed(false) }
    catch { setFailed(true) }
  }
  const { tick } = useAutoRefresh()
  useEffect(() => { load() }, [hours])
  useEffect(() => { if (tick > 0) load() }, [tick])

  const label = WINDOWS.find(w => w.hours === hours)?.label

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="f-lbl f-lbl-gold">Fleet history</p>
        <div className="flex gap-1">
          {WINDOWS.map(w => (
            <button key={w.hours} type="button" onClick={() => setHours(w.hours)}
                    className={`px-2.5 py-1 text-xs font-mono border transition-colors ${
                      hours === w.hours ? 'border-blue-500 text-white bg-gray-800' : 'border-gray-800 text-gray-400 hover:text-white'}`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {failed && !data && <Empty msg="Fleet history could not be loaded" />}

      {data && (
        <>
          <Panel title="Alerts raised" chip={`by severity · ${label}`}>
            <AlertTrend rows={data.alert_trend} spanMs={hours * 3600 * 1000} />
          </Panel>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Panel title="Noisiest rules" chip={label}>
              <BarList empty="No alerts fired in this window"
                       rows={data.top_rules.map(r => ({ key: String(r.id), label: r.name, value: r.count }))} />
            </Panel>
            <Panel title="Noisiest devices" chip={label}>
              <BarList empty="No device alerts in this window"
                       onPick={k => onPickDevice(Number(k))}
                       rows={data.top_devices.map(r => ({ key: String(r.id), label: r.name, value: r.count }))} />
            </Panel>
            <Panel title="Top CPU" chip="now">
              <BarList pct empty="No device is reporting CPU load right now"
                       onPick={k => onPickDevice(Number(k))}
                       rows={data.top_cpu.map(r => ({ key: String(r.id), label: r.name, value: r.value }))} />
            </Panel>
            <Panel title="Devices by type" chip="now">
              <BarList empty="No devices registered"
                       rows={data.by_type.map(t => ({ key: t.type, label: t.type, value: t.count }))} />
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}
