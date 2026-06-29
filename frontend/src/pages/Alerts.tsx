import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getToken, OID_META } from '../api/client'

// ── Interfaces ────────────────────────────────────────────────────────────────

interface AlertEvent {
  id: number
  severity: string
  message: string
  details: Record<string, unknown>
  fired_at: string
  acked_at: string | null
  resolved_at?: string | null
  rule_id: number
  rule_name: string
  rule_type: string
  acked_by: string | null
}

interface AlertRule {
  id: number
  name: string
  description: string
  rule_type: string
  conditions: Record<string, unknown>
  time_window_min: number
  severity: string
  channels: string[]
  cooldown_min: number
  enabled: boolean
  builtin?: number
  created_at: string
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

const SEV_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
  warning:  'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40',
  info:     'bg-blue-500/20 text-blue-400 border border-blue-500/40',
}

const TOPIC_STYLES: Record<string, string> = {
  Device:    'bg-sky-500/15 text-sky-400 border border-sky-500/30',
  Trap:      'bg-orange-500/15 text-orange-400 border border-orange-500/30',
  Threshold: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
}

const CHANNELS_AVAILABLE = ['inapp', 'slack', 'email', 'pagerduty', 'webhook']

const RULE_TYPES: Array<{ value: string; label: string; group: string; hint: string }> = [
  // Device
  { value: 'device_down',           label: 'Device down',              group: 'Device',    hint: 'Fire when a polled device stops responding to SNMP' },
  { value: 'poll_failure',          label: 'Poll failure spike',        group: 'Device',    hint: 'Fire when poll errors for a device exceed a threshold' },
  { value: 'snmp_auth_failure',     label: 'Auth failure',              group: 'Device',    hint: 'Fire on repeated SNMP authentication failures from a device' },
  { value: 'device_unreachable',    label: 'Device poll gap',           group: 'Device',    hint: 'Fire when no SNMP data arrives for a device for N minutes' },
  // Interface
  { value: 'interface_down',        label: 'Interface down',            group: 'Interface', hint: 'Fire when ifOperStatus=0 for the entire eval window' },
  { value: 'interface_flap',        label: 'Interface flapping',        group: 'Interface', hint: 'Fire when an interface status changes more than N times in a window' },
  // Metric
  { value: 'metric_threshold',      label: 'Metric threshold',          group: 'Metric',    hint: 'Fire when an OID value or computed rate crosses a fixed threshold' },
  { value: 'metric_spike',          label: 'Metric spike',              group: 'Metric',    hint: 'Fire when a recent metric mean is N× above its baseline average' },
  { value: 'error_rate',            label: 'Error rate',                group: 'Metric',    hint: 'Fire when ifInErrors or ifOutErrors rate exceeds a threshold' },
  { value: 'discard_rate',          label: 'Discard rate',              group: 'Metric',    hint: 'Fire when ifInDiscards or ifOutDiscards rate exceeds a threshold' },
  { value: 'high_error_ratio',      label: 'High error ratio',          group: 'Metric',    hint: 'Fire when errors/packets ratio exceeds a threshold %' },
  { value: 'bandwidth_utilization', label: 'Bandwidth utilization',     group: 'Metric',    hint: 'Fire when interface utilization (rate/speed) exceeds a threshold %' },
  { value: 'speed_change',          label: 'Interface speed change',    group: 'Metric',    hint: 'Fire when ifSpeed changes by more than N%' },
  // Trap
  { value: 'unknown_trap_source',   label: 'Unknown trap source',       group: 'Trap',      hint: 'Fire when traps arrive from an unregistered device' },
  { value: 'trap_rate_spike',       label: 'Trap rate spike',           group: 'Trap',      hint: 'Fire when trap volume from a source spikes above a threshold' },
  { value: 'trap_oid_match',        label: 'Trap OID match',            group: 'Trap',      hint: 'Fire when a specific OID appears in a received trap' },
  { value: 'trap_received',         label: 'Specific trap received',    group: 'Trap',      hint: 'Fire when a trap matching an OID prefix is received' },
  // Collector
  { value: 'collector_gap',         label: 'Collector data gap',        group: 'Collector', hint: 'Fire when no polls arrive from a collector for N minutes' },
  // Threshold (legacy)
  { value: 'oid_threshold',         label: 'OID value threshold',       group: 'Threshold', hint: 'Fire when a polled OID value crosses a fixed threshold' },
  { value: 'oid_missing',           label: 'OID missing',               group: 'Threshold', hint: 'Fire when an expected OID disappears from poll results' },
]

function ruleGroup(rule_type: string): string {
  return RULE_TYPES.find(r => r.value === rule_type)?.group ?? 'Other'
}

const RULE_DEFAULTS: Record<string, { name: string; description: string }> = {
  device_down:           { name: 'Device unreachable',       description: 'Alert when a polled device stops responding to SNMP requests' },
  poll_failure:          { name: 'Poll failure spike',        description: 'Alert when SNMP poll errors for a device exceed a threshold' },
  snmp_auth_failure:     { name: 'SNMP auth failure',        description: 'Alert when a device repeatedly fails SNMP authentication' },
  device_unreachable:    { name: 'Device poll gap',          description: 'Alert when no SNMP data arrives for a device within the silence window' },
  interface_down:        { name: 'Interface down',           description: 'Alert when ifOperStatus is down for the entire evaluation window' },
  interface_flap:        { name: 'Interface flapping',       description: 'Alert when an interface changes state more than N times in a window' },
  metric_threshold:      { name: 'Metric threshold',         description: 'Alert when an OID value or computed rate crosses a threshold' },
  metric_spike:          { name: 'Metric spike',             description: 'Alert when a recent metric mean is significantly above its baseline' },
  error_rate:            { name: 'Error rate',               description: 'Alert when interface error rate exceeds a threshold' },
  discard_rate:          { name: 'Discard rate',             description: 'Alert when interface discard rate exceeds a threshold' },
  high_error_ratio:      { name: 'High error ratio',         description: 'Alert when errors as a percentage of packets exceeds a threshold' },
  bandwidth_utilization: { name: 'Bandwidth utilization',    description: 'Alert when interface utilization exceeds a threshold percentage' },
  speed_change:          { name: 'Interface speed change',   description: 'Alert when ifSpeed changes significantly' },
  unknown_trap_source:   { name: 'Unknown trap source',      description: 'Alert when trap traffic arrives from an unregistered device' },
  trap_rate_spike:       { name: 'Trap rate spike',          description: 'Alert when trap volume from a source spikes above a threshold' },
  trap_oid_match:        { name: 'Trap OID match',           description: 'Alert when a specific OID appears in a received trap' },
  trap_received:         { name: 'Specific trap received',   description: 'Alert when a trap matching an OID prefix is received' },
  collector_gap:         { name: 'Collector data gap',       description: 'Alert when no polls arrive from a collector within the silence window' },
  oid_threshold:         { name: 'OID value threshold',      description: 'Alert when a polled OID value crosses a fixed threshold' },
  oid_missing:           { name: 'OID missing from poll',    description: 'Alert when an expected OID disappears from poll results' },
}

// ── Conditions builder ────────────────────────────────────────────────────────

type Cond = Record<string, unknown>

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

const OPERATOR_OPTS = [
  { value: 'gt',  label: '> greater than' },
  { value: 'gte', label: '≥ at least' },
  { value: 'lt',  label: '< less than' },
  { value: 'lte', label: '≤ at most' },
]

function ConditionsBuilder({ ruleType, conds, onChange }: {
  ruleType: string
  conds: Cond
  onChange: (c: Cond) => void
}) {
  const set = (key: string, val: unknown) => onChange({ ...conds, [key]: val })
  const g = (key: string, def: unknown) => (conds[key] !== undefined ? conds[key] : def)

  if (ruleType === 'device_down') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Silence threshold (minutes)" hint="Alert if a device sends no poll responses for this long">
          <TextInput type="number" value={String(g('silence_minutes', 10))} onChange={v => set('silence_minutes', parseInt(v) || 10)} />
        </Field>
        <Field label="Device IP (optional)" hint="Leave blank to monitor all polled devices">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'poll_failure') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Failure threshold (count)" hint="Alert when this many consecutive poll errors occur">
          <TextInput type="number" value={String(g('threshold_count', 3))} onChange={v => set('threshold_count', parseInt(v) || 3)} />
        </Field>
        <Field label="Device IP (optional)" hint="Leave blank to monitor all polled devices">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'snmp_auth_failure') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Failure threshold (count)" hint="Alert after this many auth failures in the eval window">
          <TextInput type="number" value={String(g('threshold_count', 5))} onChange={v => set('threshold_count', parseInt(v) || 5)} />
        </Field>
        <Field label="Device IP (optional)" hint="Leave blank to monitor all devices">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'unknown_trap_source') {
    return (
      <p className="text-xs text-gray-500 italic">No conditions — fires whenever a trap arrives from an unregistered device.</p>
    )
  }

  if (ruleType === 'trap_rate_spike') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Max traps per minute" hint="Alert when trap rate from a source exceeds this">
          <TextInput type="number" value={String(g('threshold_per_minute', 60))} onChange={v => set('threshold_per_minute', parseInt(v) || 60)} />
        </Field>
        <Field label="Source IP (optional)" hint="Leave blank to check total trap rate across all sources">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'trap_oid_match') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="OID to match" hint="Alert when this OID appears in a received trap">
          <TextInput value={String(g('oid', ''))} onChange={v => set('oid', v)} placeholder="e.g. 1.3.6.1.6.3.1.1.5.3" />
        </Field>
        <Field label="Source IP (optional)" hint="Leave blank to match traps from any source">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'oid_threshold') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="OID" hint="The polled OID to evaluate">
          <TextInput value={String(g('oid', ''))} onChange={v => set('oid', v)} placeholder="e.g. 1.3.6.1.2.1.2.2.1.10.1" />
        </Field>
        <Field label="Operator">
          <SelectInput value={String(g('operator', 'gt'))} onChange={v => set('operator', v)} options={OPERATOR_OPTS} />
        </Field>
        <Field label="Threshold value" hint="Numeric value to compare the OID reading against">
          <TextInput type="number" value={String(g('value', 0))} onChange={v => set('value', parseFloat(v) || 0)} />
        </Field>
        <Field label="Device IP (optional)" hint="Leave blank to check this OID across all devices">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'oid_missing') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="OID" hint="Alert when this OID stops appearing in poll results">
          <TextInput value={String(g('oid', ''))} onChange={v => set('oid', v)} placeholder="e.g. 1.3.6.1.2.1.1.1.0" />
        </Field>
        <Field label="Device IP (optional)" hint="Leave blank to monitor across all devices">
          <TextInput value={String(g('device_ip', ''))} onChange={v => set('device_ip', v)} placeholder="e.g. 192.168.1.1" />
        </Field>
      </div>
    )
  }

  // ── New SNMP metric rule types ────────────────────────────────────────────

  const OID_OPTS = Object.entries(OID_META).map(([k, v]) => ({ value: k, label: v.label }))
  const DIR_OPTS = [{ value: 'both', label: 'Both (in + out)' }, { value: 'in', label: 'In only' }, { value: 'out', label: 'Out only' }]
  const OP_OPTS  = [{ value: '>', label: '> greater than' }, { value: '>=', label: '≥ at least' }, { value: '<', label: '< less than' }, { value: '<=', label: '≤ at most' }]

  if (ruleType === 'device_unreachable') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Silence threshold (minutes)" hint="Alert when no polls arrive for a device for this long">
          <TextInput type="number" value={String(g('silence_minutes', 15))} onChange={v => set('silence_minutes', parseInt(v) || 15)} />
        </Field>
        <Field label="Device ID (optional)" hint="Leave blank to monitor all devices">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'interface_down') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Device ID (optional)" hint="Leave blank to monitor all devices">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'interface_flap') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Flap threshold (# of state changes)" hint="Alert when status changes this many times in the eval window">
          <TextInput type="number" value={String(g('flap_threshold', 3))} onChange={v => set('flap_threshold', parseInt(v) || 3)} />
        </Field>
        <Field label="Device ID (optional)" hint="Leave blank to monitor all devices">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'metric_threshold') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="OID / Metric">
          <SelectInput value={String(g('oid_label', 'ifInOctets'))} onChange={v => set('oid_label', v)} options={OID_OPTS} />
        </Field>
        <Field label="Operator">
          <SelectInput value={String(g('operator', '>'))} onChange={v => set('operator', v)} options={OP_OPTS} />
        </Field>
        <Field label="Threshold value" hint="Raw value or rate (bytes/s if Use Rate is enabled)">
          <TextInput type="number" value={String(g('threshold', 0))} onChange={v => set('threshold', parseFloat(v) || 0)} />
        </Field>
        <Field label="Use rate (for counter OIDs)" hint="Compute bytes/s from delta before comparing">
          <SelectInput
            value={String(g('use_rate', false))}
            onChange={v => set('use_rate', v === 'true')}
            options={[{ value: 'false', label: 'Raw value (gauge OIDs)' }, { value: 'true', label: 'Rate (bytes/s — counter OIDs)' }]}
          />
        </Field>
        <Field label="Device ID (optional)" hint="Leave blank to check all devices">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'metric_spike') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="OID / Metric">
          <SelectInput value={String(g('oid_label', 'ifInOctets'))} onChange={v => set('oid_label', v)} options={OID_OPTS} />
        </Field>
        <Field label="Spike factor" hint="Alert when recent mean is this many times above baseline (e.g. 3 = 3×)">
          <TextInput type="number" value={String(g('spike_factor', 3))} onChange={v => set('spike_factor', parseFloat(v) || 3)} />
        </Field>
        <Field label="Recent window (minutes)" hint="'Recent' period to compare against baseline">
          <TextInput type="number" value={String(g('recent_min', 5))} onChange={v => set('recent_min', parseInt(v) || 5)} />
        </Field>
        <Field label="Baseline window (minutes)" hint="Longer window used as the baseline average">
          <TextInput type="number" value={String(g('baseline_min', 60))} onChange={v => set('baseline_min', parseInt(v) || 60)} />
        </Field>
        <Field label="Device ID (optional)">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'error_rate') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Direction">
          <SelectInput value={String(g('direction', 'both'))} onChange={v => set('direction', v)} options={DIR_OPTS} />
        </Field>
        <Field label="Threshold (errors/sec)">
          <TextInput type="number" value={String(g('threshold', 1))} onChange={v => set('threshold', parseFloat(v) || 1)} />
        </Field>
        <Field label="Device ID (optional)">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'discard_rate') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Direction">
          <SelectInput value={String(g('direction', 'both'))} onChange={v => set('direction', v)} options={DIR_OPTS} />
        </Field>
        <Field label="Threshold (discards/sec)">
          <TextInput type="number" value={String(g('threshold', 1))} onChange={v => set('threshold', parseFloat(v) || 1)} />
        </Field>
        <Field label="Device ID (optional)">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'high_error_ratio') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Direction">
          <SelectInput value={String(g('direction', 'both'))} onChange={v => set('direction', v)} options={DIR_OPTS} />
        </Field>
        <Field label="Threshold (%)" hint="Alert when errors exceed this % of total packets">
          <TextInput type="number" value={String(g('threshold', 1))} onChange={v => set('threshold', parseFloat(v) || 1)} />
        </Field>
        <Field label="Device ID (optional)">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'bandwidth_utilization') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Direction">
          <SelectInput value={String(g('direction', 'both'))} onChange={v => set('direction', v)} options={DIR_OPTS} />
        </Field>
        <Field label="Threshold (%)" hint="Alert when interface utilization exceeds this % of ifSpeed">
          <TextInput type="number" value={String(g('threshold', 80))} onChange={v => set('threshold', parseFloat(v) || 80)} />
        </Field>
        <Field label="Device ID (optional)">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'speed_change') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Minimum change (%)" hint="Alert when ifSpeed changes by more than this percent">
          <TextInput type="number" value={String(g('delta_pct', 10))} onChange={v => set('delta_pct', parseFloat(v) || 10)} />
        </Field>
        <Field label="Device ID (optional)">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'trap_received') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Trap OID prefix" hint="Match traps whose OID starts with this value (empty = any trap)">
          <TextInput value={String(g('trap_oid_prefix', ''))} onChange={v => set('trap_oid_prefix', v)} placeholder="e.g. 1.3.6.1.6.3.1.1.5" />
        </Field>
        <Field label="Device ID (optional)" hint="Leave blank to match traps from any device">
          <TextInput type="number" value={String(g('device_id', ''))} onChange={v => set('device_id', v ? parseInt(v) : undefined)} placeholder="Device ID" />
        </Field>
      </div>
    )
  }

  if (ruleType === 'collector_gap') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Silence threshold (minutes)" hint="Alert when no polls arrive from the collector for this long">
          <TextInput type="number" value={String(g('silence_minutes', 15))} onChange={v => set('silence_minutes', parseInt(v) || 15)} />
        </Field>
        <Field label="Collector ID (optional)" hint="Leave blank to monitor all collectors">
          <TextInput type="number" value={String(g('collector_id', ''))} onChange={v => set('collector_id', v ? parseInt(v) : undefined)} placeholder="Collector ID" />
        </Field>
      </div>
    )
  }

  return null
}

// ── Alert details panel ───────────────────────────────────────────────────────
type DetailMap = Record<string, unknown>

function fmtVal(v: unknown): string {
  if (typeof v === 'number') return v > 999 ? v.toLocaleString() : String(v)
  return String(v)
}

function MiniTable({ title, headers, rows }: {
  title: string
  headers: string[]
  rows: (string | number)[][]
}) {
  if (!rows.length) return null
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1.5 uppercase tracking-wide">{title}</p>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-gray-500">
            {headers.map((h, i) => (
              <th key={i} className={`pb-1 font-normal ${i === headers.length - 1 ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-gray-800/70">
              {row.map((cell, ci) => (
                <td key={ci} className={`py-1 ${ci === row.length - 1 ? 'text-right text-gray-200' : 'text-gray-200 font-mono'}`}>
                  {typeof cell === 'string' ? cell : cell.toLocaleString()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DetailsPanel({ details }: { details: DetailMap }) {
  const TABLE_KEYS = new Set(['top_sources', 'failed_oids', 'sample_traps'])
  const CHIP_KEYS  = ['device_ip', 'source_ip', 'oid']
  const META_SKIP  = new Set([...CHIP_KEYS, ...TABLE_KEYS])

  const chips: [string, string, string][] = []
  CHIP_KEYS.forEach(k => {
    const v = details[k] as string | undefined
    if (v) {
      const label = k === 'device_ip' ? 'Device' : k === 'source_ip' ? 'Source' : 'OID'
      chips.push([k, label, v])
    }
  })

  const kvs = Object.entries(details).filter(([k]) => !META_SKIP.has(k))
  const topSources  = details.top_sources  as Array<{ ip: string; count: number }> | undefined
  const failedOids  = details.failed_oids  as Array<{ oid: string; error: string }> | undefined
  const sampleTraps = details.sample_traps as Array<{ source_ip: string; oid: string }> | undefined

  return (
    <div className="mt-3 space-y-3">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map(([k, label, v]) => (
            <span key={k} className="text-xs bg-blue-500/15 text-blue-300 border border-blue-500/25 px-2.5 py-0.5 rounded-full">
              <span className="text-blue-500/70 mr-1">{label}</span>{v}
            </span>
          ))}
        </div>
      )}
      {kvs.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {kvs.map(([k, v]) => (
            <span key={k} className="text-xs">
              <span className="text-gray-500">{k.replace(/_/g, ' ')}: </span>
              <span className="text-gray-200 font-medium">{fmtVal(v)}</span>
            </span>
          ))}
        </div>
      )}
      <MiniTable
        title="Top sources"
        headers={['Source IP', 'Count']}
        rows={(topSources || []).map(s => [s.ip, s.count])}
      />
      <MiniTable
        title="Failed OIDs"
        headers={['OID', 'Error']}
        rows={(failedOids || []).map(f => [f.oid, f.error])}
      />
      <MiniTable
        title="Sample traps"
        headers={['Source IP', 'OID']}
        rows={(sampleTraps || []).map(t => [t.source_ip, t.oid])}
      />
    </div>
  )
}

// ── Alert event card ──────────────────────────────────────────────────────────
function EventCard({ event, onAck }: { event: AlertEvent; onAck: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isAcked    = Boolean(event.acked_at)
  const isResolved = Boolean(event.resolved_at) && !isAcked
  const hasDetails = Object.keys(event.details).length > 0

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 transition-opacity ${
      isAcked ? 'opacity-40 border-gray-800' : isResolved ? 'opacity-70 border-gray-700' : 'border-gray-700'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium capitalize ${SEV_STYLES[event.severity] ?? SEV_STYLES.info}`}>
            {event.severity}
          </span>
          {isResolved && (
            <span className="shrink-0 text-xs px-2 py-0.5 rounded-full font-medium bg-green-500/20 text-green-400 border border-green-500/40">
              auto-resolved
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{event.rule_name}</p>
            <p className="text-sm text-white mt-0.5">{event.message}</p>
            {isResolved && event.resolved_at && (
              <p className="text-xs text-green-500/70 mt-0.5">Resolved {fmtTime(event.resolved_at)}</p>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className="text-xs text-white">{fmtTime(event.fired_at)}</span>
          {!isAcked && (
            <button
              onClick={() => onAck(event.id)}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-white border border-gray-700 rounded px-2.5 py-1 transition-colors"
            >
              Ack
            </button>
          )}
          {isAcked && <span className="text-xs text-green-500">✓ Acked</span>}
        </div>
      </div>

      {hasDetails && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {expanded ? '▾ Hide details' : '▸ Show details'}
          </button>
          {expanded && (
            <div className="mt-1 bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2">
              <DetailsPanel details={event.details as DetailMap} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Custom rule type selector ─────────────────────────────────────────────────
function RuleTypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selected = RULE_TYPES.find(r => r.value === value)
  const groups = RULE_TYPES.reduce<Record<string, typeof RULE_TYPES>>((acc, rt) => {
    ;(acc[rt.group] = acc[rt.group] || []).push(rt)
    return acc
  }, {})

  const TOPIC_BADGE: Record<string, string> = {
    Device:    'text-sky-400',
    Trap:      'text-orange-400',
    Threshold: 'text-emerald-400',
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white text-left flex items-center justify-between focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <span>{selected?.label ?? 'Select type…'}</span>
        <span className="text-gray-500 ml-2">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden max-h-80 overflow-y-auto">
          {Object.entries(groups).map(([grp, types]) => (
            <div key={grp}>
              <p className={`px-3 pt-2.5 pb-1 text-xs font-semibold uppercase tracking-wider ${TOPIC_BADGE[grp] ?? 'text-gray-400'}`}>
                {grp}
              </p>
              {types.map(rt => (
                <button
                  key={rt.value}
                  type="button"
                  onClick={() => { onChange(rt.value); setOpen(false) }}
                  className={`w-full text-left px-3 py-2 hover:bg-gray-700 transition-colors ${rt.value === value ? 'bg-gray-700/60' : ''}`}
                >
                  <p className="text-sm text-white">{rt.label}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{rt.hint}</p>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Rule form ─────────────────────────────────────────────────────────────────
interface RuleFormData {
  name: string; description: string; enabled: boolean; rule_type: string
  severity: string; channels: string[]; cooldown_min: string; time_window_min: string
  conditions: Cond
}

const EMPTY_RULE: RuleFormData = {
  name:        RULE_DEFAULTS['device_down']?.name ?? '',
  description: RULE_DEFAULTS['device_down']?.description ?? '',
  enabled: true, rule_type: 'device_down',
  severity: 'warning', channels: ['inapp'], cooldown_min: '30', time_window_min: '5',
  conditions: {},
}

function fromRule(r: AlertRule): RuleFormData {
  return {
    name: r.name, description: r.description, enabled: r.enabled,
    rule_type: r.rule_type, severity: r.severity,
    channels: r.channels, cooldown_min: String(r.cooldown_min),
    time_window_min: String(r.time_window_min ?? 5),
    conditions: (r.conditions as Cond) ?? {},
  }
}

function RuleForm({
  initial, onSave, onCancel, saving,
}: {
  initial: RuleFormData
  onSave: (data: RuleFormData) => Promise<void>
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<RuleFormData>(initial)
  const set = <K extends keyof RuleFormData>(k: K, v: RuleFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const setRuleType = (t: string) => setForm(f => {
    const prevDefault = RULE_DEFAULTS[f.rule_type]
    const newDefault  = RULE_DEFAULTS[t] ?? { name: '', description: '' }
    const nameIsDefault = !f.name.trim()        || f.name        === prevDefault?.name
    const descIsDefault = !f.description.trim() || f.description === prevDefault?.description
    return {
      ...f,
      rule_type:   t,
      conditions:  {},
      name:        nameIsDefault ? newDefault.name : f.name,
      description: descIsDefault ? newDefault.description : f.description,
    }
  })

  const toggleChannel = (ch: string) => {
    set('channels', form.channels.includes(ch)
      ? form.channels.filter(c => c !== ch)
      : [...form.channels, ch])
  }

  const hasConditions = !['unknown_trap_source'].includes(form.rule_type)

  return (
    <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-5 space-y-5">
      <h3 className="text-sm font-semibold text-white">{initial.name ? 'Edit rule' : 'New alert rule'}</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-400 mb-1">Rule type</label>
          <RuleTypeSelect value={form.rule_type} onChange={setRuleType} />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-400 mb-1">Rule name</label>
          <input
            value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="My alert rule"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-400 mb-1">Description (optional)</label>
          <input
            value={form.description}
            onChange={e => set('description', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Severity</label>
          <select
            value={form.severity}
            onChange={e => set('severity', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Cooldown (minutes)</label>
          <input
            type="number" min="1" max="1440"
            value={form.cooldown_min}
            onChange={e => set('cooldown_min', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Eval window (minutes)</label>
          <input
            type="number" min="1" max="1440"
            value={form.time_window_min}
            onChange={e => set('time_window_min', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {hasConditions && (
        <div>
          <p className="text-xs font-medium text-gray-400 mb-3 uppercase tracking-wide">Conditions</p>
          <div className="bg-gray-800/50 border border-gray-700/60 rounded-lg p-4">
            <ConditionsBuilder
              ruleType={form.rule_type}
              conds={form.conditions}
              onChange={c => set('conditions', c)}
            />
          </div>
        </div>
      )}

      <div>
        <label className="block text-xs text-gray-400 mb-2">Notification channels</label>
        <div className="flex flex-wrap gap-2">
          {CHANNELS_AVAILABLE.map(ch => {
            const active = form.channels.includes(ch)
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannel(ch)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize ${
                  active
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800 border-gray-700 text-white hover:border-gray-500'
                }`}
              >
                {ch}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.name.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button
          onClick={onCancel}
          className="text-white hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
type Tab = 'active' | 'history' | 'rules'

export default function Alerts() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab]               = useState<Tab>('active')
  const [events, setEvents]         = useState<AlertEvent[]>([])
  const [history, setHistory]       = useState<AlertEvent[]>([])
  const [rules, setRules]           = useState<AlertRule[]>([])
  const [loading, setLoading]       = useState(false)
  const [editRule, setEditRule]     = useState<AlertRule | null>(null)
  const [addingRule, setAddingRule] = useState(false)
  const [newRuleInitial, setNewRuleInitial] = useState<typeof EMPTY_RULE>(EMPTY_RULE)
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [eventsFilter, setEventsFilter]         = useState('')
  const [eventsSevFilter, setEventsSevFilter]   = useState('')
  const [historyFilter, setHistoryFilter]       = useState('')
  const [historySevFilter, setHistorySevFilter] = useState('')
  const [rulesFilter, setRulesFilter]           = useState('')
  const [rulesTopicFilter, setRulesTopicFilter] = useState('')
  const [rulesSortKey, setRulesSortKey]         = useState<keyof AlertRule | 'topic' | null>(null)
  const [rulesSortDir, setRulesSortDir]         = useState<'asc' | 'desc'>('asc')

  const authHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken() ?? ''}`,
  }), [])

  const toggleRulesSort = (key: keyof AlertRule | 'topic') => {
    if (rulesSortKey === key) setRulesSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setRulesSortKey(key); setRulesSortDir('asc') }
  }

  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const headers = authHeaders()
      const [activeRes, ackedRes] = await Promise.all([
        fetch('/api/alerts/events?acked=false&limit=200', { headers }),
        fetch('/api/alerts/events?acked=true&limit=200', { headers }),
      ])
      if (activeRes.ok) setEvents(await activeRes.json())
      if (ackedRes.ok)  setHistory(await ackedRes.json())
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  const loadRules = useCallback(async () => {
    const res = await fetch('/api/alerts/rules', { headers: authHeaders() })
    if (res.ok) setRules(await res.json())
  }, [authHeaders])

  useEffect(() => {
    loadEvents()
    loadRules()
  }, [loadEvents, loadRules])

  // Handle ?new=<rule_type>&device_id=<id> URL params from Metrics / Dashboard
  useEffect(() => {
    const newType  = searchParams.get('new')
    const deviceId = searchParams.get('device_id')
    const devName  = searchParams.get('device_name')
    if (!newType) return
    const defaults = RULE_DEFAULTS[newType]
    const initial: typeof EMPTY_RULE = {
      ...EMPTY_RULE,
      rule_type:   newType,
      name:        defaults?.name ?? '',
      description: defaults?.description ?? '',
      conditions:  deviceId ? { device_id: parseInt(deviceId, 10) } : {},
    }
    if (devName && defaults) {
      initial.name = `${defaults.name} — ${devName}`
    }
    setNewRuleInitial(initial)
    setAddingRule(true)
    setTab('rules')
    // Clear the params so re-visiting the page doesn't re-open the form
    setSearchParams({}, { replace: true })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleAck = async (id: number) => {
    await fetch(`/api/alerts/events/${id}/ack`, { method: 'POST', headers: authHeaders() })
    await loadEvents()
  }

  const handleAckAll = async () => {
    await fetch('/api/alerts/events/ack-all', { method: 'POST', headers: authHeaders() })
    await loadEvents()
  }

  const handleToggle = async (rule: AlertRule) => {
    setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
    try {
      const res = await fetch(`/api/alerts/rules/${rule.id}/toggle`, {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error()
    } catch {
      setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: rule.enabled } : r))
    }
  }

  const handleDeleteRule = async (id: number) => {
    if (!confirm('Delete this alert rule? All associated alert events will also be deleted.')) return
    const res = await fetch(`/api/alerts/rules/${id}`, { method: 'DELETE', headers: authHeaders() })
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      setError(`Failed to delete rule: ${msg}`)
      return
    }
    await loadRules()
  }

  const handleSaveRule = async (form: RuleFormData) => {
    setSaving(true)
    setError('')
    try {
      const body = {
        name: form.name, description: form.description, enabled: form.enabled,
        rule_type: form.rule_type,
        conditions: form.conditions,
        time_window_min: parseInt(form.time_window_min) || 5,
        severity: form.severity, channels: form.channels,
        cooldown_min: parseInt(form.cooldown_min) || 30,
      }
      let res: Response
      if (editRule) {
        res = await fetch(`/api/alerts/rules/${editRule.id}`, {
          method: 'PUT', headers: authHeaders(), body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        setEditRule(null)
      } else {
        res = await fetch('/api/alerts/rules', {
          method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        setAddingRule(false)
      }
      await loadRules()
    } catch (e) {
      setError(`Failed to save rule (${e})`)
    } finally {
      setSaving(false)
    }
  }

  const unackedCount = events.filter(e => !e.resolved_at).length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Alerts</h1>
          <p className="text-sm text-white mt-0.5">
            {(() => {
              const active   = events.filter(e => !e.resolved_at).length
              const resolved = events.filter(e => e.resolved_at).length
              if (active > 0)
                return `${active} active alert${active !== 1 ? 's' : ''}${resolved > 0 ? `, ${resolved} auto-resolved` : ''}`
              if (resolved > 0)
                return `${resolved} auto-resolved alert${resolved !== 1 ? 's' : ''} — all conditions cleared`
              return 'No active alerts'
            })()}
          </p>
        </div>
        {tab === 'active' && events.length > 0 && (
          <button
            onClick={handleAckAll}
            className="text-sm border border-gray-700 hover:border-gray-500 text-white rounded-lg px-4 py-2 transition-colors"
          >
            Ack all
          </button>
        )}
        {tab === 'rules' && !addingRule && !editRule && (
          <button
            onClick={() => setAddingRule(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            + New rule
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['active', 'history', 'rules'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-1.5 rounded-lg transition-colors capitalize ${
              tab === t ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
            }`}
          >
            {t}
            {t === 'active' && unackedCount > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5">
                {unackedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Active events */}
      {tab === 'active' && (
        <div className="space-y-3">
          {/* Filter bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              value={eventsFilter}
              onChange={e => setEventsFilter(e.target.value)}
              placeholder="Filter by rule name or message…"
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-gray-600 w-56 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {eventsFilter && <button onClick={() => setEventsFilter('')} className="text-xs text-white hover:text-white">✕</button>}
            <select
              value={eventsSevFilter}
              onChange={e => setEventsSevFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            {eventsSevFilter && <button onClick={() => setEventsSevFilter('')} className="text-xs text-white hover:text-white">✕</button>}
            {(eventsFilter || eventsSevFilter) && (
              <span className="text-xs text-white ml-auto">
                {events.filter(e =>
                  (!eventsSevFilter || e.severity === eventsSevFilter) &&
                  (!eventsFilter || e.rule_name.toLowerCase().includes(eventsFilter.toLowerCase()) || e.message.toLowerCase().includes(eventsFilter.toLowerCase()))
                ).length} result{events.filter(e =>
                  (!eventsSevFilter || e.severity === eventsSevFilter) &&
                  (!eventsFilter || e.rule_name.toLowerCase().includes(eventsFilter.toLowerCase()) || e.message.toLowerCase().includes(eventsFilter.toLowerCase()))
                ).length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {loading && <p className="text-sm text-white">Loading…</p>}
          {!loading && events.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 text-white">
              <p className="text-2xl mb-2">✓</p>
              <p className="text-sm">No unacknowledged alerts</p>
            </div>
          )}
          {events
            .filter(e =>
              (!eventsSevFilter || e.severity === eventsSevFilter) &&
              (!eventsFilter || e.rule_name.toLowerCase().includes(eventsFilter.toLowerCase()) || e.message.toLowerCase().includes(eventsFilter.toLowerCase()))
            )
            .map(e => <EventCard key={e.id} event={e} onAck={handleAck} />)
          }
          {!loading && events.length > 0 && events.filter(e =>
            (!eventsSevFilter || e.severity === eventsSevFilter) &&
            (!eventsFilter || e.rule_name.toLowerCase().includes(eventsFilter.toLowerCase()) || e.message.toLowerCase().includes(eventsFilter.toLowerCase()))
          ).length === 0 && (
            <p className="text-sm text-white text-center py-8">No alerts match this filter</p>
          )}
        </div>
      )}

      {/* History */}
      {tab === 'history' && (
        <div className="space-y-3">
          {/* Filter bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              value={historyFilter}
              onChange={e => setHistoryFilter(e.target.value)}
              placeholder="Filter by rule name or message…"
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-gray-600 w-56 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {historyFilter && <button onClick={() => setHistoryFilter('')} className="text-xs text-white hover:text-white">✕</button>}
            <select
              value={historySevFilter}
              onChange={e => setHistorySevFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            {historySevFilter && <button onClick={() => setHistorySevFilter('')} className="text-xs text-white hover:text-white">✕</button>}
            {(historyFilter || historySevFilter) && (
              <span className="text-xs text-white ml-auto">
                {history.filter(e =>
                  (!historySevFilter || e.severity === historySevFilter) &&
                  (!historyFilter || e.rule_name.toLowerCase().includes(historyFilter.toLowerCase()) || e.message.toLowerCase().includes(historyFilter.toLowerCase()))
                ).length} result{history.filter(e =>
                  (!historySevFilter || e.severity === historySevFilter) &&
                  (!historyFilter || e.rule_name.toLowerCase().includes(historyFilter.toLowerCase()) || e.message.toLowerCase().includes(historyFilter.toLowerCase()))
                ).length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {history.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-32 text-white">
              <p className="text-sm">No alert history</p>
            </div>
          )}
          {history
            .filter(e =>
              (!historySevFilter || e.severity === historySevFilter) &&
              (!historyFilter || e.rule_name.toLowerCase().includes(historyFilter.toLowerCase()) || e.message.toLowerCase().includes(historyFilter.toLowerCase()))
            )
            .map(e => <EventCard key={e.id} event={e} onAck={handleAck} />)
          }
          {history.length > 0 && history.filter(e =>
            (!historySevFilter || e.severity === historySevFilter) &&
            (!historyFilter || e.rule_name.toLowerCase().includes(historyFilter.toLowerCase()) || e.message.toLowerCase().includes(historyFilter.toLowerCase()))
          ).length === 0 && (
            <p className="text-sm text-white text-center py-8">No alerts match this filter</p>
          )}
        </div>
      )}

      {/* Rules */}
      {tab === 'rules' && (
        <div className="space-y-4">
          {addingRule && (
            <RuleForm
              initial={newRuleInitial}
              onSave={handleSaveRule}
              onCancel={() => setAddingRule(false)}
              saving={saving}
            />
          )}
          {editRule && (
            <RuleForm
              initial={fromRule(editRule)}
              onSave={handleSaveRule}
              onCancel={() => setEditRule(null)}
              saving={saving}
            />
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {(() => {
            const displayedRules = rules
              .filter(r => {
                if (rulesTopicFilter && ruleGroup(r.rule_type) !== rulesTopicFilter) return false
                if (!rulesFilter) return true
                const q = rulesFilter.toLowerCase()
                return r.name.toLowerCase().includes(q) ||
                  r.rule_type.toLowerCase().includes(q) ||
                  r.severity.toLowerCase().includes(q)
              })
              .sort((a, b) => {
                if (!rulesSortKey) return 0
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const av = rulesSortKey === 'topic' ? ruleGroup(a.rule_type) : a[rulesSortKey] as any
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const bv = rulesSortKey === 'topic' ? ruleGroup(b.rule_type) : b[rulesSortKey] as any
                if (typeof av === 'number') return rulesSortDir === 'asc' ? av - bv : bv - av
                return rulesSortDir === 'asc'
                  ? String(av ?? '').localeCompare(String(bv ?? ''))
                  : String(bv ?? '').localeCompare(String(av ?? ''))
              })

            const RULE_COLS: Array<{ label: string; key: keyof AlertRule | 'topic' | null }> = [
              { label: 'Enabled',  key: null },
              { label: 'Rule',     key: 'name' },
              { label: 'Group',    key: 'topic' },
              { label: 'Type',     key: 'rule_type' },
              { label: 'Severity', key: 'severity' },
              { label: 'Channels', key: null },
              { label: 'Cooldown', key: 'cooldown_min' },
              { label: '',         key: null },
            ]

            return (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-3 flex-wrap">
                  <input
                    value={rulesFilter}
                    onChange={e => setRulesFilter(e.target.value)}
                    placeholder="Filter by name, type, severity…"
                    className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-gray-600 w-52 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  {rulesFilter && <button onClick={() => setRulesFilter('')} className="text-xs text-white hover:text-white">✕</button>}
                  <select
                    value={rulesTopicFilter}
                    onChange={e => setRulesTopicFilter(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">All groups</option>
                    <option value="Device">Device</option>
                    <option value="Trap">Trap</option>
                    <option value="Threshold">Threshold</option>
                  </select>
                  {rulesTopicFilter && (
                    <button onClick={() => setRulesTopicFilter('')} className="text-xs text-white hover:text-white">✕</button>
                  )}
                  <span className="text-xs text-white ml-auto">{displayedRules.length} rule{displayedRules.length !== 1 ? 's' : ''}</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      {RULE_COLS.map(col => (
                        <th
                          key={col.label}
                          onClick={() => col.key && toggleRulesSort(col.key)}
                          className={`px-4 py-3 text-left text-xs font-medium select-none
                            ${col.key ? `cursor-pointer ${rulesSortKey === col.key ? 'text-blue-400' : 'text-white hover:text-gray-200'}` : 'text-white'}`}
                        >
                          {col.label}
                          {rulesSortKey === col.key && col.key && <span className="ml-1">{rulesSortDir === 'asc' ? '↑' : '↓'}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {displayedRules.map(rule => (
                      <tr key={rule.id} className="hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => handleToggle(rule)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                              rule.enabled ? 'bg-blue-600' : 'bg-gray-700'
                            }`}
                          >
                            <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                              rule.enabled ? 'translate-x-5' : 'translate-x-1'
                            }`} />
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-white">{rule.name}</p>
                          {rule.description && (
                            <p className="text-xs text-white mt-0.5">{rule.description}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const grp = ruleGroup(rule.rule_type)
                            return (
                              <span className={`text-xs px-2 py-0.5 rounded-full ${TOPIC_STYLES[grp] ?? 'bg-gray-800 text-gray-400'}`}>
                                {grp}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="px-4 py-3 text-white text-xs">
                          <span className="bg-gray-800 px-2 py-0.5 rounded">{rule.rule_type}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${SEV_STYLES[rule.severity] ?? SEV_STYLES.info}`}>
                            {rule.severity}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-white">{rule.channels.join(', ')}</td>
                        <td className="px-4 py-3 text-xs text-white">{rule.cooldown_min}m</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => { setEditRule(rule); setAddingRule(false) }}
                              className="text-xs text-white hover:text-blue-400 transition-colors"
                            >
                              Edit
                            </button>
                            {!rule.builtin && (
                              <button
                                onClick={() => handleDeleteRule(rule.id)}
                                className="text-xs text-white hover:text-red-400 transition-colors"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {displayedRules.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-sm text-white">
                          {rulesFilter ? 'No rules match this filter' : 'No alert rules yet — click "+ New rule" to add one'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
