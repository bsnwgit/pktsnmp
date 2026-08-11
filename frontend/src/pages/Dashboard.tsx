import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  api, SnmpDashboard,
  EnvironmentNode, OrgTreeNode, GroupTreeNode, SiteTreeNode, LocationTreeNode, DeviceTreeNode,
} from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import DeviceMetricsPanel from '../components/DeviceMetricsPanel'
import HelpButton from '../components/HelpButton'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(ts: string | null): string {
  if (!ts) return '—'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  return new Date(utc).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function fmtClock(ts: string | null): string {
  if (!ts) return '—'
  const utc = ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z'
  return new Date(utc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Readout ───────────────────────────────────────────────────────────────────
// Replaces the old stat card. No fill, no border of its own — the row is a
// single hairline grid, and each cell reveals corner ticks on hover.

function Readout({
  label, value, sub, tone = 'ink', gauge, onClick,
}: {
  label: string
  value: string | number
  sub?: string
  tone?: 'ink' | 'gold' | 'alarm'
  gauge?: number            // 0–100; draws the arc ring
  onClick?: () => void
}) {
  const R = 22
  const C = 2 * Math.PI * R

  return (
    <div
      className={`f-tick relative bg-gray-950 px-5 py-4 min-h-[118px] flex flex-col min-w-0 transition-colors ${
        gauge !== undefined ? 'pr-[74px]' : ''
      } ${onClick ? 'cursor-pointer hover:bg-blue-500/[0.03]' : ''}`}
      onClick={onClick}
    >
      <div className="f-lbl f-lbl-gold">{label}</div>

      {gauge !== undefined && (
        <svg className="absolute top-3.5 right-3.5" width="52" height="52" viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r={R} stroke="rgba(216,180,110,.20)" strokeWidth="2" />
          <circle
            cx="26" cy="26" r={R}
            stroke="#d8b46e" strokeWidth="2" strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - Math.max(0, Math.min(100, gauge)) / 100)}
            transform="rotate(-90 26 26)"
            style={{ filter: 'drop-shadow(0 0 5px rgba(216,180,110,.5))', transition: 'stroke-dashoffset .6s ease' }}
          />
          <circle cx="26" cy="26" r="15" stroke="rgba(216,180,110,.44)" />
        </svg>
      )}

      <div className={`f-num text-[clamp(26px,2.6vw,38px)] mt-2.5 mb-2 ${
        tone === 'gold' ? 'f-num-gold' : tone === 'alarm' ? 'f-num-alarm' : 'text-white'
      }`}>
        {value}
      </div>

      {sub && <div className="font-mono text-[9.5px] text-gray-500 mt-auto">{sub}</div>}
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
    <span className={`flex-shrink-0 font-mono text-[9px] px-2 py-0.5 border whitespace-nowrap ${
      isDown
        ? 'text-red-500 border-red-500/40 bg-red-500/[0.06]'
        : 'text-yellow-400 border-yellow-400/36 bg-yellow-400/[0.05]'
    }`}>
      {count} alert{count !== 1 ? 's' : ''}
    </span>
  )
}

// ── Collapse chevron ──────────────────────────────────────────────────────────

function CollapseIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="flex-shrink-0 w-2.5 text-[8px] leading-none text-gray-500">
      {expanded ? '▾' : '▸'}
    </span>
  )
}

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ tone, pulse, size = 6 }: { tone: string; pulse?: boolean; size?: number }) {
  const ring = tone === 'f-dot-down' ? 'rgba(255,107,94,.9)'
             : tone === 'f-dot-warn' ? 'rgba(240,182,74,.9)'
             : 'transparent'
  return (
    <span className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <span className={`f-dot ${tone} absolute inset-0`} />
      {pulse && (
        <span
          className="absolute rounded-full animate-ping opacity-70"
          style={{ inset: -3, border: `1px solid ${ring}` }}
        />
      )}
    </span>
  )
}

// ── Tier row ──────────────────────────────────────────────────────────────────
// Hierarchy is carried by tracking + ink weight, not by nested boxes.

const TIER_STYLE: Record<string, { nm: string; row: string; dot: number }> = {
  org:      { nm: 'text-[11.5px] uppercase text-blue-300', row: 'bg-blue-500/[0.045]', dot: 6 },
  group:    { nm: 'text-[11px] uppercase text-white',      row: 'bg-white/[0.03]',    dot: 6 },
  site:     { nm: 'text-[10px] uppercase text-gray-400',   row: '',                    dot: 5 },
  location: { nm: 'text-[9.5px] uppercase text-gray-500',  row: '',                    dot: 5 },
}

const TIER_TRACK: Record<string, string> = {
  org: '0.3em', group: '0.22em', site: '0.2em', location: '0.2em',
}

function ContainerRow({
  tier, name, alerts, status, expanded, onToggle,
}: {
  tier: 'org' | 'group' | 'site' | 'location'
  name: string
  alerts: number
  status: SubtreeStatus
  expanded: boolean
  onToggle: () => void
}) {
  const s = TIER_STYLE[tier]
  return (
    <div
      className={`relative flex items-center gap-3 px-4 py-2.5 cursor-pointer border-b border-gray-900 hover:bg-blue-500/[0.035] transition-colors ${s.row}`}
      onClick={onToggle}
    >
      <CollapseIcon expanded={expanded} />
      <StatusDot tone={subtreeDotTone(status)} pulse={subtreeDotPulse(status)} size={s.dot} />
      <span className={`${s.nm} whitespace-nowrap`} style={{ letterSpacing: TIER_TRACK[tier] }}>{name}</span>
      <span className="text-[8px] uppercase text-gray-500 whitespace-nowrap" style={{ letterSpacing: '0.26em' }}>
        {tier}
      </span>
      <div className="flex-1" />
      <AlertBadge count={alerts} isDown={status === 'down'} />
      <span className="w-[104px]" />
      <span className="text-[11px] text-gray-500">›</span>
    </div>
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
      <ContainerRow tier="org" name={node.name} alerts={node.subtree_alerts}
                    status={st} expanded={expanded} onToggle={() => setExpanded(x => !x)} />
      {expanded && (
        <div className="border-l border-blue-500/25 ml-5">
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
      <ContainerRow tier="group" name={node.name} alerts={node.subtree_alerts}
                    status={st} expanded={expanded} onToggle={() => setExpanded(x => !x)} />
      {expanded && (
        <div className="border-l border-blue-500/25 ml-5">
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
      <ContainerRow tier="site" name={node.name} alerts={node.subtree_alerts}
                    status={st} expanded={expanded} onToggle={() => setExpanded(x => !x)} />
      {expanded && (
        <div className="border-l border-blue-500/25 ml-5">
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

// ── LocationNode ──────────────────────────────────────────────────────────────

function LocationNode({
  node, signal, onNavigate,
}: {
  node: LocationTreeNode; signal: CollapseSignal; onNavigate: (n: DeviceTreeNode) => void
}) {
  const [expanded, setExpanded] = useCollapseSync(signal)
  const st = subtreeStatus(node.children)
  return (
    <div>
      <ContainerRow tier="location" name={node.name} alerts={node.subtree_alerts}
                    status={st} expanded={expanded} onToggle={() => setExpanded(x => !x)} />
      {expanded && (
        <div className="border-l border-blue-500/25 ml-5">
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

function dotTone(node: DeviceTreeNode): string {
  if (!node.enabled)           return 'f-dot-off'
  if (node.status === 'down')  return 'f-dot-down'
  if (node.subtree_alerts > 0) return 'f-dot-warn'
  if (node.status === 'up')    return 'f-dot-up'
  return 'f-dot-off'
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

function subtreeDotTone(st: SubtreeStatus): string {
  if (st === 'down')   return 'f-dot-down'
  if (st === 'alerts') return 'f-dot-warn'
  if (st === 'up')     return 'f-dot-up'
  return 'f-dot-off'
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
        className={`relative flex items-center gap-3 py-2.5 pr-4 border-b border-gray-900 transition-colors group ${
          node.enabled ? 'hover:bg-blue-500/[0.035] cursor-pointer' : 'cursor-not-allowed'
        } ${isAlerting ? 'bg-red-500/[0.02]' : ''}`}
        style={{ paddingLeft: `${16 + depth * 20}px` }}
        onClick={() => { if (node.enabled) onNavigate(node) }}
      >
        {/* Disabled: hatched strike rather than a solid overlay bar */}
        {!node.enabled && (
          <div
            className="absolute left-0 right-0 top-1/2 h-px pointer-events-none"
            style={{ background: 'repeating-linear-gradient(90deg, rgba(255,107,94,.32) 0 6px, transparent 6px 12px)' }}
          />
        )}

        {/* Expand toggle */}
        <button
          className={`flex-shrink-0 w-2.5 text-[8px] leading-none text-gray-500 hover:text-blue-400 transition-colors ${!hasChildren ? 'invisible' : ''}`}
          onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
        >
          {expanded ? '▾' : '▸'}
        </button>

        <StatusDot tone={dotTone(node)} pulse={dotPulse(node)} size={6} />

        {/* Name + tags + IP */}
        <div className="min-w-0 flex-1 flex items-center gap-2.5">
          <span className={`font-mono text-xs whitespace-nowrap ${node.enabled ? 'text-white' : 'text-gray-500'}`}>
            {node.name}
          </span>
          {!node.enabled && (
            <span className="text-[8px] text-red-500/60" style={{ letterSpacing: '0.32em' }}>DISABLED</span>
          )}
          {node.device_type && (
            <span className="f-chip">{node.device_type.replace('_', ' ')}</span>
          )}
          {node.ha_role && (
            <span className={node.ha_role === 'active' ? 'f-chip f-chip-ice' : 'f-chip'}>
              {node.ha_role}
            </span>
          )}
          {node.parent_name && (
            <span className="f-chip">Parent: {node.parent_name}</span>
          )}
          <span className="font-mono text-[10px] text-gray-500">{node.ip}</span>
        </div>

        {/* Alert badge */}
        {node.subtree_alerts > 0 && (
          <span className={`flex-shrink-0 font-mono text-[9px] px-2 py-0.5 border whitespace-nowrap ${
            node.status === 'down'
              ? 'text-red-500 border-red-500/40 bg-red-500/[0.06]'
              : 'text-yellow-400 border-yellow-400/36 bg-yellow-400/[0.05]'
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
        <span className="flex-shrink-0 font-mono text-[9px] text-gray-500 hidden lg:block w-[104px] text-right">
          {fmtRelative(node.last_seen)}
        </span>

        <span className="flex-shrink-0 text-[11px] text-gray-500 group-hover:text-blue-500 transition-colors">›</span>
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="border-l border-blue-500/25" style={{ marginLeft: `${29 + depth * 20}px` }}>
          {node.children.map(child => {
            if (child.type !== 'device') return null
            return (
              <DeviceNode
                key={child.id}
                node={child}
                depth={0}
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
  if (node.type === 'org')      return <OrgNode      node={node} signal={signal} onNavigate={onNavigate} />
  if (node.type === 'group')    return <GroupNode    node={node} signal={signal} onNavigate={onNavigate} />
  if (node.type === 'site')     return <SiteNode     node={node} signal={signal} onNavigate={onNavigate} />
  if (node.type === 'location') return <LocationNode node={node} signal={signal} onNavigate={onNavigate} />
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
    <div className={`f-panel ${totalAlerting > 0 ? 'f-panel-alarm' : ''}`}>
      {/* Header */}
      <div className={`f-head ${totalAlerting > 0 ? 'border-red-500/[0.22] bg-red-500/[0.022]' : ''}`}>
        <span className="text-[10px] uppercase text-white whitespace-nowrap" style={{ letterSpacing: '0.32em' }}>
          Environment
        </span>
        {!loading && (
          <span className="font-mono text-[9.5px] text-gray-500 whitespace-nowrap">
            {totalDevices} node{totalDevices !== 1 ? 's' : ''}
          </span>
        )}
        {totalAlerting > 0 && (
          <span className="font-mono text-[9.5px] text-red-500 whitespace-nowrap">{totalAlerting} alerting</span>
        )}
        <div className="ml-auto flex gap-4">
          {!loading && nodes.length > 0 && (
            <>
              <button onClick={collapseAll} className="f-lbl hover:text-blue-400 transition-colors">Collapse all</button>
              <button onClick={expandAll} className="f-lbl hover:text-blue-400 transition-colors">Expand all</button>
            </>
          )}
          <button onClick={() => navigate('/devices')} className="f-lbl hover:text-blue-400 transition-colors">Manage →</button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="px-5 py-10 f-lbl">Acquiring…</div>
      ) : nodes.length === 0 ? (
        <div className="px-5 py-10 f-lbl">
          No devices configured.{' '}
          <button onClick={() => navigate('/devices')} className="text-blue-400 hover:text-blue-300">Add one →</button>
        </div>
      ) : (
        <div>
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

// ── Telemetry column ──────────────────────────────────────────────────────────

function TeleHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 mb-3.5">
      <span className="f-lbl">{children}</span>
      <div className="flex-1 h-px bg-blue-500/25" />
    </div>
  )
}

/** Concentric survey rings — fabric integrity as a Prime-Radiant-style dial. */
function Radiant({ pct, loading }: { pct: number; loading: boolean }) {
  const R = 58
  const C = 2 * Math.PI * R
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2 - Math.PI / 2
    const long = i % 6 === 0
    const r1 = long ? 30 : 34
    return {
      x1: 96 + Math.cos(a) * r1, y1: 96 + Math.sin(a) * r1,
      x2: 96 + Math.cos(a) * 38, y2: 96 + Math.sin(a) * 38,
      o: long ? 0.7 : 0.28,
    }
  })

  return (
    <div className="grid place-items-center py-1">
      <div className="relative">
        <svg width="192" height="192" viewBox="0 0 192 192" fill="none">
          <g className="f-spin-slow">
            <circle cx="96" cy="96" r="88" stroke="rgba(216,180,110,.1)" />
            <circle cx="96" cy="96" r="88" stroke="rgba(216,180,110,.5)" strokeDasharray="2 20" />
            <circle cx="96" cy="8" r="2.4" fill="#d8b46e" />
          </g>
          <g className="f-spin-rev">
            <circle cx="96" cy="96" r="72" stroke="rgba(126,207,226,.16)" />
            <circle cx="96" cy="96" r="72" stroke="rgba(126,207,226,.5)" strokeDasharray="34 260" strokeLinecap="round" />
            <circle cx="24" cy="96" r="1.8" fill="#7ecfe2" />
          </g>
          <circle cx="96" cy="96" r={R} stroke="rgba(216,180,110,.18)" />
          <circle
            cx="96" cy="96" r={R}
            stroke="#d8b46e" strokeWidth="1.6" strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - Math.max(0, Math.min(100, pct)) / 100)}
            transform="rotate(-90 96 96)"
            style={{ transition: 'stroke-dashoffset .8s ease' }}
          />
          <circle cx="96" cy="96" r="44" stroke="rgba(216,180,110,.26)" />
          <g stroke="rgba(216,180,110,.44)">
            {ticks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} opacity={t.o} />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 grid place-content-center text-center">
          <div className="f-num f-num-gold text-[26px]">{loading ? '—' : pct.toFixed(1)}</div>
          <div className="f-lbl mt-1.5">Integrity</div>
        </div>
      </div>
    </div>
  )
}

/** 24h trap flux — built from the timeline the dashboard already fetches. */
function TrapFlux({ timeline, total }: { timeline: Array<{ hour: string; count: number }>; total: number }) {
  const W = 250, H = 54
  const pts = timeline.length ? timeline : []
  const max = Math.max(1, ...pts.map(p => p.count))
  const step = pts.length > 1 ? W / (pts.length - 1) : W

  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(H - (p.count / max) * (H - 8)).toFixed(1)}`).join(' ')
  const area = pts.length ? `${line} L${W},${H} L0,${H} Z` : ''
  const peakIdx = pts.reduce((best, p, i) => (p.count > pts[best].count ? i : best), 0)

  return (
    <div className="f-panel px-3 pt-3 pb-2">
      <div className="flex items-baseline gap-2.5 mb-2.5">
        <span className="f-num text-[17px] text-white">{total.toLocaleString()}</span>
        <span className="f-lbl">events</span>
      </div>
      {pts.length === 0 ? (
        <div className="h-[54px] grid place-items-center f-lbl">No trap activity</div>
      ) : (
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="fluxfade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(126,207,226,.28)" />
              <stop offset="100%" stopColor="rgba(126,207,226,0)" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#fluxfade)" />
          <path d={line} fill="none" stroke="#7ecfe2" strokeWidth="1" opacity=".85" />
          <circle
            cx={(peakIdx * step).toFixed(1)}
            cy={(H - (pts[peakIdx].count / max) * (H - 8)).toFixed(1)}
            r="2" fill="#7ecfe2"
          />
        </svg>
      )}
      <div className="flex justify-between mt-1">
        <span className="f-lbl" style={{ letterSpacing: '0.16em' }}>-24h</span>
        <span className="f-lbl" style={{ letterSpacing: '0.16em' }}>now</span>
      </div>
    </div>
  )
}

function TopSources({ sources }: { sources: Array<{ source_ip: string; count: number }> }) {
  const max = Math.max(1, ...sources.map(s => s.count))
  if (!sources.length) return <div className="f-lbl py-2">No sources</div>
  return (
    <div>
      {sources.slice(0, 5).map((s, i) => (
        <div key={s.source_ip} className="flex items-center gap-2.5 py-1.5 border-b border-gray-900">
          <span className="font-mono text-[9px] text-gray-500 w-4">{String(i + 1).padStart(2, '0')}</span>
          <span className="font-mono text-[10.5px] text-gray-400">{s.source_ip}</span>
          <span className="flex-1 h-px bg-gold-500/25 relative">
            <span
              className="absolute left-0 -top-px h-[3px]"
              style={{
                width: `${(s.count / max) * 100}%`,
                background: 'linear-gradient(90deg, rgba(126,207,226,.15), rgba(126,207,226,.55))',
              }}
            />
          </span>
          <span className="font-mono text-[10px] text-cyan-400 w-9 text-right">{s.count}</span>
        </div>
      ))}
    </div>
  )
}

function EventStream({ traps }: { traps: SnmpDashboard['recent_traps'] }) {
  if (!traps.length) return <div className="f-lbl py-2">Stream idle</div>
  return (
    <div>
      {traps.slice(0, 8).map((t, i) => (
        <div key={i} className="grid grid-cols-[52px_1fr] gap-2.5 py-1.5 border-b border-gray-900">
          <span className="font-mono text-[9px] text-gray-500 pt-px">{fmtClock(t.received_at)}</span>
          <span className="text-[10.5px] leading-relaxed text-gray-400 break-all">
            <b className="font-mono font-normal text-white">{t.source_ip}</b>{' '}
            <span className="text-gray-500">{t.trap_oid}</span>
          </span>
        </div>
      ))}
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
  const reachablePct = devCounts.total > 0 ? (devCounts.up / devCounts.total) * 100 : 0
  const peak = dash.trap_timeline.reduce(
    (best, p) => (p.count > best.count ? p : best),
    { hour: '', count: 0 },
  )

  return (
    <>
      {/* Backdrop when panel is open */}
      {selectedDevice && (
        <div
          className="fixed inset-0 z-30 bg-black/50"
          onClick={() => setSelectedDevice(null)}
        />
      )}

      <DeviceMetricsPanel device={selectedDevice} onClose={() => setSelectedDevice(null)} />

      {/* Page head */}
      <div className="flex items-end gap-4 mb-6">
        <h1 className="text-[19px] text-white">Dashboard</h1>
        <div className="mb-1"><HelpButton title="Dashboard — How It Works">
          <p>The readouts are clickable shortcuts into Devices/Alerts, filtered to that count.</p>
          <p>The tree below mirrors the <span className="text-gray-300">Org → Group → Site → Location</span> hierarchy defined in Settings → Hierarchy — clicking a device opens a metrics panel in place rather than navigating away, so you can keep browsing the tree.</p>
        </HelpButton></div>
        <div className="f-rule mb-1.5" />
        <span className="font-mono text-[9px] uppercase text-gray-500 tracking-[0.2em] whitespace-nowrap">
          Auto-refresh · 30s
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_296px] gap-6">

        {/* ── main column ── */}
        <div className="min-w-0 space-y-6">
          <div
            className="grid grid-cols-2 md:grid-cols-4 gap-px border"
            style={{ background: 'rgba(216,180,110,.08)', borderColor: 'rgba(216,180,110,.08)' }}
          >
            <Readout
              label="Devices"
              value={loading ? '…' : devCounts.total}
              sub={devCounts.total > 0 ? `${devCounts.up} up · ${devCounts.down} down · ${devCounts.unknown} unknown` : undefined}
              onClick={() => navigate('/devices')}
            />
            <Readout
              label="Reachable"
              value={loading ? '…' : `${Math.round(reachablePct)}%`}
              tone="gold"
              gauge={reachablePct}
              sub={devCounts.total > 0 ? `${devCounts.up} of ${devCounts.total} responding` : undefined}
            />
            <Readout
              label="Traps · 24h"
              value={loading ? '…' : dash.traps_24h.toLocaleString()}
              sub={peak.count > 0 ? `peak ${peak.count}/h` : undefined}
            />
            <Readout
              label="Active Alerts"
              value={loading ? '…' : dash.active_alerts}
              tone={dash.active_alerts > 0 ? 'alarm' : 'ink'}
              onClick={dash.active_alerts > 0 ? () => navigate('/alerts') : undefined}
            />
          </div>

          <EnvironmentTree nodes={tree} loading={loading} onDeviceSelect={setSelectedDevice} />
        </div>

        {/* ── telemetry column ── */}
        <aside className="space-y-7 min-w-0">
          <section>
            <TeleHead>Fabric Integrity</TeleHead>
            <Radiant pct={reachablePct} loading={loading} />
          </section>

          <section>
            <TeleHead>Trap Flux · 24h</TeleHead>
            <TrapFlux timeline={dash.trap_timeline} total={dash.traps_24h} />
          </section>

          <section>
            <TeleHead>Top Sources</TeleHead>
            <TopSources sources={dash.top_sources} />
          </section>

          <section>
            <TeleHead>Event Stream</TeleHead>
            <EventStream traps={dash.recent_traps} />
          </section>
        </aside>
      </div>
    </>
  )
}
