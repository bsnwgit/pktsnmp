import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  api, SnmpDashboard,
  EnvironmentNode, OrgTreeNode, GroupTreeNode, SiteTreeNode, DeviceTreeNode,
} from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import DeviceMetricsPanel from '../components/DeviceMetricsPanel'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(ts: string | null): string {
  if (!ts) return '—'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  const secs = Math.floor((Date.now() - new Date(utc).getTime()) / 1000)
  if (secs < 60)    return `${secs}s ago`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
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

// ── Collapse/expand signal ────────────────────────────────────────────────────

// Increment seq to broadcast a collapse/expand to all nodes.
type CollapseSignal = { expanded: boolean; seq: number }

function useCollapseSync(signal: CollapseSignal, init = true) {
  const [expanded, setExpanded] = useState(init)
  const seenSeq = useRef(-1)
  useEffect(() => {
    if (signal.seq !== seenSeq.current) {
      seenSeq.current = signal.seq
      setExpanded(signal.expanded)
    }
  }, [signal])
  return [expanded, setExpanded] as const
}

// ── Alert badge ───────────────────────────────────────────────────────────────

function AlertBadge({ count, isDown }: { count: number; isDown?: boolean }) {
  if (count === 0) return null
  return (
    <span className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${
      isDown
        ? 'bg-red-500/20 text-red-400 border border-red-500/40'
        : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
    }`}>
      {count} alert{count !== 1 ? 's' : ''}
    </span>
  )
}

// ── OrgNode ───────────────────────────────────────────────────────────────────

function OrgNode({
  node, signal, onNavigate,
}: {
  node: OrgTreeNode; signal: CollapseSignal; onNavigate: (n: DeviceTreeNode) => void
}) {
  const [expanded, setExpanded] = useCollapseSync(signal)
  const st = subtreeStatus(node.children)
  return (
    <div>
      <div
        className="flex items-center gap-2 px-4 py-3 bg-gray-800/70 border-b border-gray-700/60 cursor-pointer hover:bg-gray-800 transition-colors"
        onClick={() => setExpanded(x => !x)}
      >
        <span className="text-xs text-gray-400 w-4 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
        <span className="relative flex-shrink-0">
          <span className={`w-2.5 h-2.5 rounded-full block ${subtreeDotColor(st)}`} />
          {(st === 'down' || st === 'alerts') && (
            <span className={`absolute inset-0 rounded-full animate-ping opacity-60 ${st === 'down' ? 'bg-red-500' : 'bg-yellow-400'}`} />
          )}
        </span>
        <span className="text-sm font-bold text-white tracking-wide">{node.name}</span>
        <span className="text-xs text-gray-500 ml-1">org</span>
        <div className="flex-1" />
        <AlertBadge count={node.subtree_alerts} />
      </div>
      {expanded && node.children.map(child => (
        <EnvironmentNodeComp
          key={child.type === 'device' ? child.id : `${child.type}-${child.name}`}
          node={child} signal={signal} onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

// ── GroupNode ─────────────────────────────────────────────────────────────────

function GroupNode({
  node, signal, onNavigate,
}: {
  node: GroupTreeNode; signal: CollapseSignal; onNavigate: (n: DeviceTreeNode) => void
}) {
  const [expanded, setExpanded] = useCollapseSync(signal)
  const st = subtreeStatus(node.children)
  return (
    <div>
      <div
        className="flex items-center gap-2 pl-8 pr-4 py-2.5 bg-gray-800/40 border-b border-gray-800/60 cursor-pointer hover:bg-gray-800/60 transition-colors"
        onClick={() => setExpanded(x => !x)}
      >
        <span className="text-xs text-gray-500 w-4 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
        <span className="relative flex-shrink-0">
          <span className={`w-2 h-2 rounded-full block ${subtreeDotColor(st)}`} />
          {(st === 'down' || st === 'alerts') && (
            <span className={`absolute inset-0 rounded-full animate-ping opacity-60 ${st === 'down' ? 'bg-red-500' : 'bg-yellow-400'}`} />
          )}
        </span>
        <span className="text-sm font-semibold text-gray-200">{node.name}</span>
        <span className="text-xs text-gray-600 ml-1">group</span>
        <div className="flex-1" />
        <AlertBadge count={node.subtree_alerts} />
      </div>
      {expanded && node.children.map(child => (
        <EnvironmentNodeComp
          key={child.type === 'device' ? child.id : `${child.type}-${child.name}`}
          node={child} signal={signal} onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

// ── SiteNode ──────────────────────────────────────────────────────────────────

function SiteNode({
  node, signal, onNavigate,
}: {
  node: SiteTreeNode; signal: CollapseSignal; onNavigate: (n: DeviceTreeNode) => void
}) {
  const [expanded, setExpanded] = useCollapseSync(signal)
  const st = subtreeStatus(node.children)
  return (
    <div>
      <div
        className="flex items-center gap-2 pl-12 pr-4 py-2 border-b border-gray-800/40 cursor-pointer hover:bg-gray-800/20 transition-colors"
        onClick={() => setExpanded(x => !x)}
      >
        <span className="text-xs text-gray-600 w-4 flex-shrink-0">{expanded ? '▾' : '▸'}</span>
        <span className="relative flex-shrink-0">
          <span className={`w-2 h-2 rounded-full block ${subtreeDotColor(st)}`} />
          {(st === 'down' || st === 'alerts') && (
            <span className={`absolute inset-0 rounded-full animate-ping opacity-60 ${st === 'down' ? 'bg-red-500' : 'bg-yellow-400'}`} />
          )}
        </span>
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{node.name}</span>
        <span className="text-xs text-gray-700 ml-1">site</span>
        <div className="flex-1" />
        <AlertBadge count={node.subtree_alerts} />
      </div>
      {expanded && (
        <div className="border-l border-gray-800/50 ml-[52px]">
          {node.children.map(child => (
            <EnvironmentNodeComp
              key={child.type === 'device' ? child.id : `${child.type}-${child.name}`}
              node={child} signal={signal} onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── DeviceNode ────────────────────────────────────────────────────────────────

function dotColor(node: DeviceTreeNode): string {
  if (!node.enabled)               return 'bg-gray-600'
  if (node.status === 'down')      return 'bg-red-500'
  if (node.subtree_alerts > 0)     return 'bg-yellow-400'
  if (node.status === 'up')        return 'bg-green-500'
  return 'bg-gray-500'
}

function dotPulse(node: DeviceTreeNode): boolean {
  return node.enabled && (node.status === 'down' || node.subtree_alerts > 0)
}

// ── Subtree status helpers ─────────────────────────────────────────────────────

type SubtreeStatus = 'down' | 'alerts' | 'up' | 'unknown'

function subtreeStatus(nodes: EnvironmentNode[]): SubtreeStatus {
  let best: SubtreeStatus = 'unknown'
  for (const n of nodes) {
    if (n.type === 'device') {
      if (!n.enabled) continue
      if (n.status === 'down') return 'down'
      if (n.subtree_alerts > 0) best = 'alerts'
      else if (n.status === 'up' && best === 'unknown') best = 'up'
    } else {
      const cs = subtreeStatus(n.children)
      if (cs === 'down') return 'down'
      if (cs === 'alerts') best = 'alerts'
      else if (cs === 'up' && best === 'unknown') best = 'up'
    }
  }
  return best
}

function subtreeDotColor(st: SubtreeStatus): string {
  if (st === 'down')   return 'bg-red-500'
  if (st === 'alerts') return 'bg-yellow-400'
  if (st === 'up')     return 'bg-green-500'
  return 'bg-gray-600'
}

function subtreeDotPulse(st: SubtreeStatus): boolean {
  return st === 'down' || st === 'alerts'
}

function DeviceNode({
  node, depth, signal, onNavigate,
}: {
  node: DeviceTreeNode; depth: number
  signal: CollapseSignal; onNavigate: (n: DeviceTreeNode) => void
}) {
  const [expanded, setExpanded] = useCollapseSync(signal)
  const hasChildren = node.children.length > 0
  const isAlerting  = node.subtree_alerts > 0 || node.status === 'down'

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-2.5 hover:bg-gray-800/40 transition-colors cursor-pointer group ${isAlerting ? 'bg-red-950/10' : ''}`}
        style={{ paddingLeft: `${16 + depth * 20}px` }}
        onClick={() => onNavigate(node)}
      >
        {/* Expand toggle */}
        <button
          className={`flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-700/60 transition-colors text-gray-500 hover:text-gray-300 ${!hasChildren ? 'invisible' : ''}`}
          onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
        >
          <span className="text-xs leading-none">{expanded ? '▾' : '▸'}</span>
        </button>

        {/* Status dot */}
        <span className="relative flex-shrink-0">
          <span className={`w-2.5 h-2.5 rounded-full block ${dotColor(node)}`} />
          {dotPulse(node) && (
            <span className={`absolute inset-0 rounded-full animate-ping opacity-60 ${node.status === 'down' ? 'bg-red-500' : 'bg-yellow-400'}`} />
          )}
        </span>

        {/* Name + IP */}
        <div className="min-w-0 flex-1">
          <span className={`text-sm font-medium truncate ${node.enabled ? 'text-white' : 'text-gray-500'}`}>
            {node.name}
          </span>
          {node.device_type && (
            <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500 border border-gray-700/50">
              {node.device_type.replace('_', ' ')}
            </span>
          )}
          {node.ha_role && (
            <span className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded ${
              node.ha_role === 'active'
                ? 'bg-blue-900/40 text-blue-300 border border-blue-700/40'
                : 'bg-gray-800 text-gray-500 border border-gray-700'
            }`}>
              {node.ha_role}
            </span>
          )}
          <span className="text-xs text-gray-500 ml-2 font-mono">{node.ip}</span>
        </div>

        {/* Alert badge */}
        {node.subtree_alerts > 0 && (
          <span className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${
            node.status === 'down'
              ? 'bg-red-500/20 text-red-400 border border-red-500/40'
              : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
          }`}>
            {node.direct_alerts > 0 && node.subtree_alerts > node.direct_alerts
              ? `${node.direct_alerts} + ${node.subtree_alerts - node.direct_alerts} below`
              : node.subtree_alerts > node.direct_alerts
              ? `${node.subtree_alerts} below`
              : node.subtree_alerts === 1 ? '1 alert' : `${node.subtree_alerts} alerts`
            }
          </span>
        )}

        {/* Last seen */}
        <span className="flex-shrink-0 text-xs text-gray-600 hidden lg:block w-16 text-right pr-4">
          {fmtRelative(node.last_seen)}
        </span>

        {/* Arrow */}
        <span className="flex-shrink-0 text-gray-700 group-hover:text-gray-400 transition-colors text-xs pr-4">›</span>
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="border-l border-gray-800/60 ml-[29px]">
          {node.children.map(child => {
            if (child.type !== 'device') return null
            return (
              <DeviceNode
                key={child.id}
                node={child}
                depth={depth + 1}
                signal={signal}
                onNavigate={onNavigate}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function EnvironmentNodeComp({
  node, signal, onNavigate,
}: {
  node: EnvironmentNode; signal: CollapseSignal; onNavigate: (n: DeviceTreeNode) => void
}) {
  if (node.type === 'org')    return <OrgNode   node={node} signal={signal} onNavigate={onNavigate} />
  if (node.type === 'group')  return <GroupNode  node={node} signal={signal} onNavigate={onNavigate} />
  if (node.type === 'site')   return <SiteNode   node={node} signal={signal} onNavigate={onNavigate} />
  return <DeviceNode node={node} depth={0} signal={signal} onNavigate={onNavigate} />
}

// ── EnvironmentTree ───────────────────────────────────────────────────────────

function countDevices(nodes: EnvironmentNode[]): number {
  return nodes.reduce((s, n) => {
    const own = n.type === 'device' ? 1 : 0
    return s + own + countDevices(n.children)
  }, 0)
}

function EnvironmentTree({
  nodes, loading, onDeviceSelect,
}: {
  nodes: EnvironmentNode[]
  loading: boolean
  onDeviceSelect: (node: DeviceTreeNode) => void
}) {
  const navigate = useNavigate()
  const [signal, setSignal] = useState<CollapseSignal>({ expanded: true, seq: 0 })

  const handleNavigate = (node: DeviceTreeNode) => {
    onDeviceSelect(node)
  }

  const totalDevices  = countDevices(nodes)
  const totalAlerting = nodes.reduce((s, n) => s + n.subtree_alerts, 0)

  const collapseAll = () => setSignal(s => ({ expanded: false, seq: s.seq + 1 }))
  const expandAll   = () => setSignal(s => ({ expanded: true,  seq: s.seq + 1 }))

  return (
    <div className={`bg-gray-900 rounded-xl overflow-hidden border ${totalAlerting > 0 ? 'border-red-500' : 'border-gray-800'}`}>
      {/* Header */}
      <div className={`px-5 py-3 border-b flex items-center justify-between ${totalAlerting > 0 ? 'border-red-500/60 bg-red-500/5' : 'border-gray-800'}`}>
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium text-white">Environment</p>
          {!loading && (
            <span className="text-xs text-gray-500">{totalDevices} device{totalDevices !== 1 ? 's' : ''}</span>
          )}
          {totalAlerting > 0 && (
            <span className="text-xs font-bold text-red-400">{totalAlerting} alerting</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!loading && nodes.length > 0 && (
            <>
              <button onClick={collapseAll} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                Collapse all
              </button>
              <button onClick={expandAll} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                Expand all
              </button>
            </>
          )}
          <button onClick={() => navigate('/devices')} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            Manage →
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="px-5 py-8 text-sm text-gray-500">Loading…</div>
      ) : nodes.length === 0 ? (
        <div className="px-5 py-8 text-sm text-gray-500">
          No devices configured.{' '}
          <button onClick={() => navigate('/devices')} className="text-blue-400 hover:text-blue-300">Add one →</button>
        </div>
      ) : (
        <div className="divide-y divide-gray-800/30">
          {nodes.map(node => (
            <EnvironmentNodeComp
              key={node.type === 'device' ? node.id : `${node.type}-${node.name}`}
              node={node}
              signal={signal}
              onNavigate={handleNavigate}
            />
          ))}
        </div>
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
  const [tree, setTree]       = useState<EnvironmentNode[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDevice, setSelectedDevice] = useState<DeviceTreeNode | null>(null)

  const load = async () => {
    try {
      const [d, t] = await Promise.all([api.getSnmpDashboard(), api.getDeviceTree()])
      setDash(d)
      setTree(t)
    } catch {}
    finally { setLoading(false) }
  }

  const { tick } = useAutoRefresh()
  useEffect(() => { load() }, [tick])
  useEffect(() => { load() }, [])

  // ESC to close panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedDevice(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const { devices: devCounts } = dash

  return (
    <>
      {/* Backdrop when panel is open */}
      {selectedDevice && (
        <div
          className="fixed inset-0 z-30 bg-black/40"
          onClick={() => setSelectedDevice(null)}
        />
      )}

      <DeviceMetricsPanel device={selectedDevice} onClose={() => setSelectedDevice(null)} />

      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-xs text-gray-600">Auto-refreshes every 30s</p>
        </div>

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
            sub={devCounts.total > 0 ? `${Math.round((devCounts.up / devCounts.total) * 100)}% reachable` : undefined}
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

        <EnvironmentTree nodes={tree} loading={loading} onDeviceSelect={setSelectedDevice} />
      </div>
    </>
  )
}
