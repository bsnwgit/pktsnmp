/**
 * pktSNMP API client — typed fetch wrappers.
 * Access token is stored in memory (not localStorage).
 */

let _accessToken: string | null = null
let _tokenRole: string | null = null

export function setToken(token: string, role: string) {
  _accessToken = token
  _tokenRole = role
}

export function clearToken() {
  _accessToken = null
  _tokenRole = null
}

export function getRole(): string | null {
  return _tokenRole
}

export function isAuthenticated(): boolean {
  return _accessToken !== null
}

export function getToken(): string | null {
  return _accessToken
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (_accessToken) {
    headers['Authorization'] = `Bearer ${_accessToken}`
  }

  const res = await fetch(`/api${path}`, { ...options, headers })

  if (res.status === 401) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${_accessToken}`
      const retry = await fetch(`/api${path}`, { ...options, headers })
      if (!retry.ok) throw new Error(`${retry.status} ${retry.statusText}`)
      return retry.json()
    }
    clearToken()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || res.statusText)
  }

  if (res.status === 204) return null as T
  return res.json()
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    if (!res.ok) return false
    const data = await res.json()
    setToken(data.access_token, data.role)
    return true
  } catch {
    return false
  }
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  login: (username: string, password: string) =>
    request<{ access_token: string; role: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  // ── Users ─────────────────────────────────────────────────────────────────
  getMe: () => request<User>('/users/me'),
  getUsers: () => request<User[]>('/users/'),
  createUser: (body: UserIn) => request<User>('/users/', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: UserIn) => request<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request(`/users/${id}`, { method: 'DELETE' }),
  activateUser: (id: number) => request(`/users/${id}/activate`, { method: 'PATCH' }),
  deactivateUser: (id: number) => request(`/users/${id}/deactivate`, { method: 'PATCH' }),
  resetUserPassword: (id: number, newPassword: string) =>
    request(`/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ new_password: newPassword }) }),
  changeMyPassword: (currentPassword: string, newPassword: string) =>
    request('/users/me/password', { method: 'PATCH', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () => request<Record<string, unknown>>('/settings/'),
  updateSetting: (key: string, value: unknown) =>
    request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  bulkUpdateSettings: (updates: Record<string, unknown>) =>
    request('/settings/bulk', { method: 'POST', body: JSON.stringify(updates) }),
  testNotification: (channel: string) =>
    request<{ status: string; detail: string }>('/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),

  // ── System ────────────────────────────────────────────────────────────────
  testStorageConnection: () =>
    request<{ ok: boolean; backend: string; message: string }>('/system/test-connection', { method: 'POST' }),
  restartService: () =>
    request<{ status: string; message: string }>('/system/restart', { method: 'POST' }),
  runCleanup: () =>
    request<{
      snmp_data_eligible: number
      alert_events_deleted: number
      notification_log_deleted: number
      clickhouse_status: string
      status: string
    }>('/system/cleanup', { method: 'POST' }),
  runBackupNow: () =>
    request<{ status: string; path: string; files: string[]; kept: number }>('/system/backup', { method: 'POST' }),
  listBackups: () =>
    request<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>('/system/backup/list'),
  importBundle: async (file: File): Promise<Record<string, string>> => {
    const formData = new FormData()
    formData.append('file', file)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/import', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  exportConfig: async (): Promise<{ blob: Blob; filename: string }> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/export', { headers })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const match = cd.match(/filename="([^"]+)"/)
    const filename = match ? match[1] : 'pktsnmp-export.tar.gz'
    return { blob, filename }
  },

  // ── SSL ───────────────────────────────────────────────────────────────────
  getSslStatus: () => request<SslStatus>('/system/ssl/status'),
  uploadSsl: async (cert: File, key: File): Promise<SslStatus> => {
    const formData = new FormData()
    formData.append('cert', cert)
    formData.append('key', key)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/ssl/upload', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  deleteSsl: () => request<SslStatus>('/system/ssl/cert', { method: 'DELETE' }),
  uploadSslPfx: async (pfx: File, passphrase: string): Promise<SslStatus> => {
    const formData = new FormData()
    formData.append('pfx', pfx)
    formData.append('passphrase', passphrase)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/ssl/upload-pfx', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  // ── Logs ──────────────────────────────────────────────────────────────────
  getLogs: (params: LogQueryParams) =>
    request<LogResponse>(`/logs?${new URLSearchParams(params as Record<string, string>)}`),
  getLogStats: () =>
    request<LogStats>('/logs/stats'),
  clearLogs: () =>
    request('/logs', { method: 'DELETE' }),
  setLogLevel: (level: string) =>
    request(`/logs/level?level=${level}`, { method: 'POST' }),

  // ── SNMP (stubs — expand as engine is built) ──────────────────────────────
  getSnmpStatus: () => request<SnmpStatus>('/snmp/status'),
  getSnmpDevices: () => request<SnmpDevice[]>('/snmp/devices'),
  getSnmpTraps: () => request<SnmpTrap[]>('/snmp/traps'),
  getSnmpDashboard: () => request<SnmpDashboard>('/snmp/dashboard'),
  getDeviceTree: () => request<EnvironmentNode[]>('/snmp/devices/tree'),

  exportDevices: async (): Promise<void> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/snmp/devices/export', { headers })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pktsnmp-devices.csv'
    a.click()
    URL.revokeObjectURL(url)
  },

  importDevices: async (file: File): Promise<{ created: number; skipped: number; errors: string[] }> => {
    const formData = new FormData()
    formData.append('file', file)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/snmp/devices/import-csv', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  // ── Alerts ────────────────────────────────────────────────────────────────
  getAlertEvents: (params?: { active?: boolean; acked?: boolean; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.active  !== undefined) q.set('active',  String(params.active))
    if (params?.acked   !== undefined) q.set('acked',   String(params.acked))
    if (params?.limit   !== undefined) q.set('limit',   String(params.limit))
    return request<Array<Record<string, unknown>>>(`/alerts/events?${q}`)
  },
  getAlertRules: () => request<Array<Record<string, unknown>>>('/alerts/rules'),
  ackAlertEvent: (id: number) => request(`/alerts/events/${id}/ack`, { method: 'POST' }),
  ackAllAlertEvents: () => request('/alerts/events/ack-all', { method: 'POST' }),

  // ── Hierarchy (Org / Group / Site pick-list definitions) ──────────────────
  getHierarchy: () => request<HierarchyOrg[]>('/snmp/hierarchy'),
  createHierarchyOrg: (name: string) =>
    request<HierarchyOrg>('/snmp/hierarchy/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteHierarchyOrg: (id: number) =>
    request<void>(`/snmp/hierarchy/orgs/${id}`, { method: 'DELETE' }),
  createHierarchyGroup: (name: string, org_id: number) =>
    request<HierarchyGroup>('/snmp/hierarchy/groups', { method: 'POST', body: JSON.stringify({ name, org_id }) }),
  deleteHierarchyGroup: (id: number) =>
    request<void>(`/snmp/hierarchy/groups/${id}`, { method: 'DELETE' }),
  createHierarchySite: (name: string, group_id: number) =>
    request<HierarchySite>('/snmp/hierarchy/sites', { method: 'POST', body: JSON.stringify({ name, group_id }) }),
  deleteHierarchySite: (id: number) =>
    request<void>(`/snmp/hierarchy/sites/${id}`, { method: 'DELETE' }),
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserIn {
  username: string
  email: string
  password?: string
  role: string
}

export interface User {
  id: number
  username: string
  email: string
  role: string
  is_active: boolean
  created_at: string
  last_login: string | null
  has_password: boolean
  auth_provider: string
}

export interface SslStatus {
  installed: boolean
  expires?: string
  expires_iso?: string
  days_until_expiry?: number
  subject?: string
  issuer?: string
  error?: string
  status?: string
}

export interface SnmpStatus {
  trap_receiver: string
  poll_engine: string
  message: string
  devices_total?: number
  traps_24h?: number
  polls_24h?: number
  active_alerts?: number
}

export interface SnmpDevice {
  id: number
  ip: string
  name: string
  site: string
  snmp_version: string
  enabled: boolean
  status: string
  last_seen: string | null
  ha_role: string | null
  collector_id: number
  collector_name: string | null
  otelcol_label: string | null
  otelcol_pipeline: string | null
  poll_interval_override: number | null
  credential_id: number | null
  credential_name: string | null
}

export interface SnmpTrap {
  id: number
  received_at: string
  source_ip: string
  oid: string
  community: string
}

// Environment hierarchy: Org → Group → Site → Device
// DB columns: org, groups (Group), site (Site)
export interface OrgTreeNode {
  type: 'org'
  name: string
  direct_alerts: number
  subtree_alerts: number
  children: EnvironmentNode[]
}
export interface GroupTreeNode {
  type: 'group'
  name: string
  direct_alerts: number
  subtree_alerts: number
  children: EnvironmentNode[]
}
export interface SiteTreeNode {
  type: 'site'
  name: string
  direct_alerts: number
  subtree_alerts: number
  children: EnvironmentNode[]
}
export interface DeviceTreeNode {
  type: 'device'
  id: number
  name: string
  ip: string
  org: string
  groups: string          // displayed as "Group"
  site: string            // displayed as "Site"
  device_type: string     // firewall|switch|wap|wlc|router|iot|ups|server|storage|pdu|camera|load_balancer|vpn|printer|other|''
  status: string          // 'up' | 'down' | 'unknown'
  enabled: boolean
  parent_device_id: number | null
  ha_role: string | null  // 'active' | 'passive' | 'standalone' | null
  ha_peer_id: number | null
  last_seen: string | null
  direct_alerts: number
  subtree_alerts: number
  children: EnvironmentNode[]
}
export type EnvironmentNode = OrgTreeNode | GroupTreeNode | SiteTreeNode | DeviceTreeNode

/** @deprecated use EnvironmentNode / DeviceTreeNode */
export type SnmpDeviceNode = DeviceTreeNode

// Org / Group / Site hierarchy definition types (pick-list for device form dropdowns)
export interface HierarchySite {
  id: number
  name: string
}

export interface HierarchyGroup {
  id: number
  name: string
  sites: HierarchySite[]
}

export interface HierarchyOrg {
  id: number
  name: string
  groups: HierarchyGroup[]
}

export interface SnmpDashboard {
  trap_timeline: Array<{ hour: string; count: number }>
  top_sources:   Array<{ source_ip: string; count: number }>
  recent_traps:  Array<{ received_at: string; source_ip: string; trap_oid: string; snmp_version: string }>
  active_alerts: number
  traps_24h:     number
  devices: {
    total:   number
    up:      number
    down:    number
    unknown: number
  }
}

export interface LogRecord {
  id: number
  ts: string
  level: string
  level_no: number
  logger: string
  message: string
  exc_info: string | null
}

export interface LogResponse {
  total: number
  limit: number
  offset: number
  records: LogRecord[]
}

export interface LogStats {
  total: number
  by_level: Record<string, number>
  loggers: string[]
  latest_ts: string | null
  capture_level?: string
}

export type LogQueryParams = {
  level?: string
  logger?: string
  search?: string
  since?: string
  limit?: string
  offset?: string
}
