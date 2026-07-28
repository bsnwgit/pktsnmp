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
  // Deliberately bypasses request() — a bad password here is a normal login
  // failure, not an expired session, and must not trigger the 401 handler's
  // refresh-then-redirect-to-/login flow (that would hard-reload the login
  // page itself before the error message is even visible).
  login: async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json() as Promise<{ access_token: string; role: string }>
  },
  // Deliberately bypasses request() for the same reason as login() above.
  autoLogin: async () => {
    const res = await fetch('/api/auth/auto-login', { method: 'POST' })
    if (!res.ok) throw new Error('Auto-login not available')
    return res.json() as Promise<{ access_token: string; role: string }>
  },
  logout: () => request('/auth/logout', { method: 'POST' }),

  // ── Users ─────────────────────────────────────────────────────────────────
  getMe: () => request<User>('/users/me'),
  getUsers: () => request<User[]>('/users/'),
  createUser: (body: UserIn) => request<User>('/users/', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: UserIn) => request<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request(`/users/${id}`, { method: 'DELETE' }),
  activateUser: (id: number) => request(`/users/${id}/activate`, { method: 'PATCH' }),
  deactivateUser: (id: number) => request(`/users/${id}/deactivate`, { method: 'PATCH' }),
  setDefaultAdmin: (id: number) => request(`/users/${id}/set-default-admin`, { method: 'PATCH' }),
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
  getSuiteToken: () =>
    request<{ suite_token: string; has_token: boolean }>('/suite/token'),

  restartService: () =>
    request<{ status: string; message: string }>('/system/restart', { method: 'POST' }),
  getPort: () =>
    request<{ port: number }>('/system/port'),
  setPort: (port: number) =>
    request<{ port: number; message: string }>('/system/port', {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),
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
  importBundle: async (file: File, files?: string[]): Promise<Record<string, string>> => {
    const formData = new FormData()
    formData.append('file', file)
    if (files) formData.append('files', files.join(','))
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/import', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  restoreSnapshot: (name: string, files?: string[]): Promise<Record<string, string>> => {
    const qs = files && files.length ? `?files=${encodeURIComponent(files.join(','))}` : ''
    return request<Record<string, string>>(`/system/backup/restore/${encodeURIComponent(name)}${qs}`, { method: 'POST' })
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

  exportCollectors: async (): Promise<void> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/snmp/collectors/export', { headers })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pktsnmp-collectors.csv'
    a.click()
    URL.revokeObjectURL(url)
  },

  importCollectors: async (file: File): Promise<{
    created: number; skipped: number; errors: string[]
    tokens: { id: number; name: string; api_token: string }[]
  }> => {
    const formData = new FormData()
    formData.append('file', file)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/snmp/collectors/import-csv', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  exportOids: async (): Promise<void> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/snmp/oids/export', { headers })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pktsnmp-oids.csv'
    a.click()
    URL.revokeObjectURL(url)
  },

  importOids: async (file: File): Promise<{ created: number; skipped: number; errors: string[] }> => {
    const formData = new FormData()
    formData.append('file', file)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/snmp/oids/import-csv', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  // ── Metrics ───────────────────────────────────────────────────────────────
  getDeviceMetricsLatest: (deviceId: number) =>
    request<MetricLatestItem[]>(`/snmp/devices/${deviceId}/metrics/latest`),

  getDeviceMetricsLatestByIp: (deviceIp: string) =>
    request<MetricLatestItem[]>(`/snmp/devices/by-ip/${encodeURIComponent(deviceIp)}/metrics/latest`),

  getDeviceMetricsHistory: (
    deviceId: number,
    params: {
      oid_labels?: string
      since?: string
      until?: string
      limit?: number
      interface_label?: string   // filter to one interface (ifDescr value)
    } = {}
  ) => {
    const q = new URLSearchParams()
    if (params.oid_labels)       q.set('oid_labels',       params.oid_labels)
    if (params.since)            q.set('since',             params.since)
    if (params.until)            q.set('until',             params.until)
    if (params.limit)            q.set('limit',             String(params.limit))
    if (params.interface_label)  q.set('interface_label',   params.interface_label)
    return request<MetricsHistoryResponse>(`/snmp/devices/${deviceId}/metrics/history?${q}`)
  },

  getMetricsOverview: () =>
    request<DeviceMetricsCard[]>('/snmp/metrics/overview'),

  getDeviceInterfaces: (deviceId: number) =>
    request<DeviceInterface[]>(`/snmp/devices/${deviceId}/interfaces`),

  downloadDeviceMetricsCsv: async (deviceId: number, since = '24h'): Promise<void> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch(`/api/snmp/devices/${deviceId}/metrics/history?since=${since}&format=csv`, { headers })
    if (!res.ok) throw new Error(`CSV export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `device-${deviceId}-metrics.csv`
    a.click()
    URL.revokeObjectURL(url)
  },

  getCollectorIngestRate: (collectorId: number, hours = 1, bucketMinutes = 5) =>
    request<IngestRateBucket[]>(
      `/snmp/collectors/${collectorId}/ingest-rate?hours=${hours}&bucket_minutes=${bucketMinutes}`
    ),

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

  // ── Hierarchy (Org / Group / Site / Location pick-list definitions) ───────
  getHierarchy: () => request<HierarchyOrg[]>('/snmp/hierarchy'),
  createHierarchyOrg: (name: string) =>
    request<HierarchyOrg>('/snmp/hierarchy/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
  updateHierarchyOrg: (id: number, name: string) =>
    request<{ id: number; name: string }>(`/snmp/hierarchy/orgs/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteHierarchyOrg: (id: number) =>
    request<void>(`/snmp/hierarchy/orgs/${id}`, { method: 'DELETE' }),
  createHierarchyGroup: (name: string, org_id: number) =>
    request<HierarchyGroup>('/snmp/hierarchy/groups', { method: 'POST', body: JSON.stringify({ name, org_id }) }),
  updateHierarchyGroup: (id: number, name: string) =>
    request<{ id: number; name: string }>(`/snmp/hierarchy/groups/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteHierarchyGroup: (id: number) =>
    request<void>(`/snmp/hierarchy/groups/${id}`, { method: 'DELETE' }),
  createHierarchySite: (name: string, group_id: number) =>
    request<HierarchySite>('/snmp/hierarchy/sites', { method: 'POST', body: JSON.stringify({ name, group_id }) }),
  updateHierarchySite: (id: number, name: string) =>
    request<{ id: number; name: string }>(`/snmp/hierarchy/sites/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteHierarchySite: (id: number) =>
    request<void>(`/snmp/hierarchy/sites/${id}`, { method: 'DELETE' }),
  createHierarchyLocation: (name: string, site_id: number) =>
    request<HierarchyLocation>('/snmp/hierarchy/locations', { method: 'POST', body: JSON.stringify({ name, site_id }) }),
  updateHierarchyLocation: (id: number, name: string) =>
    request<{ id: number; name: string }>(`/snmp/hierarchy/locations/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteHierarchyLocation: (id: number) =>
    request<void>(`/snmp/hierarchy/locations/${id}`, { method: 'DELETE' }),

  getUserApiKeys: () => request<UserApiKey[]>('/user-api-keys'),
  setUserApiKey: (provider: string, api_key: string) =>
    request<UserApiKey>(`/user-api-keys/${provider}`, { method: 'PUT', body: JSON.stringify({ api_key }) }),
  testUserApiKey: (provider: string, api_key: string) =>
    request<{ status: string; detail: string }>(`/user-api-keys/${provider}/test`, { method: 'POST', body: JSON.stringify({ api_key }) }),
  setIpinfoFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/ipinfo/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setIpapiIsFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/ipapi_is/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setIpapiIsFreeTier: (free_tier: boolean) =>
    request<UserApiKey>('/user-api-keys/ipapi_is/free-tier', { method: 'PUT', body: JSON.stringify({ free_tier }) }),
  setMxtoolboxFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/mxtoolbox/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setProviderEnabled: (provider: string, enabled: boolean) =>
    request<UserApiKey>(`/user-api-keys/${provider}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  getIpInfo: (ip: string) => request<IpInfoResult>(`/ip-info/${ip}`),
  getInternalIpInfo: (ip: string) => request<InternalIpInfoResult>(`/ip-info/internal/${ip}`),

  getIntegrations: () => request<Integration[]>('/integrations'),
  createIntegration: (body: IntegrationInput) =>
    request<Integration>('/integrations', { method: 'POST', body: JSON.stringify(body) }),
  updateIntegration: (id: number, body: Partial<IntegrationInput>) =>
    request<Integration>(`/integrations/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteIntegration: (id: number) => request(`/integrations/${id}`, { method: 'DELETE' }),
  testIntegration: (id: number) => request<{ healthy: boolean; detail: string }>(`/integrations/${id}/test`, { method: 'POST' }),
}

export interface IpInfoResult {
  ip: string
  ipinfo: Record<string, any> | null
  ipinfo_error: string | null
  ipinfo_enabled_fields: string[] | null
  ipinfo_enabled: boolean
  ipapi_is: Record<string, any> | null
  ipapi_is_error: string | null
  ipapi_is_enabled_fields: string[] | null
  ipapi_is_enabled: boolean
  abuseipdb: Record<string, any> | null
  abuseipdb_error: string | null
  abuseipdb_enabled: boolean
  mxtoolbox: Record<string, any> | null
  mxtoolbox_error: string | null
  mxtoolbox_enabled_fields: string[] | null
  mxtoolbox_enabled: boolean
}

export interface Integration {
  id: number
  name: string
  app_name: string
  base_url: string
  has_token: boolean
  enabled: boolean
  health_status: string
  last_health_check: string | null
}

export interface IntegrationInput {
  name: string
  app_name?: string
  base_url: string
  suite_token: string
  enabled?: boolean
}

export interface InternalIpInfoResult {
  ip: string
  configured: boolean
  found: boolean
  error: string | null
  subnet: { cidr: string; vlan_id: number | null; site: string | null; description: string | null; gateway: string | null } | null
  ip_address: { status: string; mac_address: string | null; hostname: string | null; description: string | null; owner: string | null; tags: string[] } | null
  dhcp_leases: { mac_address: string | null; hostname: string | null; state: string; starts_at: string | null; ends_at: string | null; last_seen: string }[]
  dns_records: { zone: string; name: string; record_type: string; ttl: number | null; last_seen: string }[]
  arp_entries: { device_label: string | null; mac_address: string | null; interface: string | null; vlan_tag: number | null; last_seen: string }[]
}

export interface UserApiKey {
  provider: string
  label: string
  api_key: string
  updated_at: string | null
  enabled_fields: string[] | null // ipinfo/ipapi_is/mxtoolbox only; null = not customized (all shown)
  free_tier: boolean // ipapi_is only — use its keyless free tier instead of api_key
  enabled: boolean // ipinfo/ipapi_is/abuseipdb/mxtoolbox only — show this provider's section in the IP Lookup modal at all
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
  is_default_admin: boolean
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

// Environment hierarchy: Org → Group → Site → Location → Device
// DB columns: org, groups (Group), site (Site), location (Location)
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
export interface LocationTreeNode {
  type: 'location'
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
  location: string        // displayed as "Location"
  device_type: string     // firewall|switch|wap|wlc|router|iot|ups|server|storage|pdu|camera|load_balancer|vpn|printer|other|''
  status: string          // 'up' | 'down' | 'unknown'
  enabled: boolean
  parent_device_id: number | null
  parent_id: number | null    // resolved parent (HA-redirected to active peer if applicable); set even when the device isn't nested under it (different location)
  parent_name: string | null
  ha_role: string | null  // 'active' | 'passive' | 'standalone' | null
  ha_peer_id: number | null
  last_seen: string | null
  direct_alerts: number
  subtree_alerts: number
  children: EnvironmentNode[]
}
export type EnvironmentNode = OrgTreeNode | GroupTreeNode | SiteTreeNode | LocationTreeNode | DeviceTreeNode

/** @deprecated use EnvironmentNode / DeviceTreeNode */
export type SnmpDeviceNode = DeviceTreeNode

// Org / Group / Site / Location hierarchy definition types (pick-list for device form dropdowns)
export interface HierarchyLocation {
  id: number
  name: string
}

export interface HierarchySite {
  id: number
  name: string
  locations: HierarchyLocation[]
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
  until?: string
  limit?: string
  offset?: string
}

// ── Metrics types ─────────────────────────────────────────────────────────────

/** One row from the metrics/latest endpoint */
export interface MetricLatestItem {
  oid_label: string
  value: string | null
  value_numeric: number | null
  value_type: string | null
  polled_at: string
}

/** One time-bucketed row from metrics/history */
export interface MetricPoint {
  bucket_ts: string
  oid_label: string
  interface_label: string | null
  avg_value: number | null
  max_value: number | null
  min_value: number | null
  sample_count: number
}

/** Alert event within a metric history window (chart annotation marker) */
export interface MetricAlertEvent {
  id: number
  fired_at: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  rule_name: string
  resolved_at: string | null
  auto_resolved: number
}

/** SNMP trap within a metric history window (timeline overlay) */
export interface MetricTrapEvent {
  id: number
  received_at: string
  trap_oid: string | null
  source_ip: string | null
}

/** Full response from GET /metrics/history */
export interface MetricsHistoryResponse {
  series: MetricPoint[]
  alert_events: MetricAlertEvent[]
  trap_events: MetricTrapEvent[]
  bucket_seconds: number
  since_iso: string | null
}

/** One bucket from GET /collectors/{id}/ingest-rate */
export interface IngestRateBucket {
  bucket_ts: string
  poll_count: number
  active_devices: number
}

// ── Time range helpers ────────────────────────────────────────────────────────

export type TimeRange = '1h' | '6h' | '24h' | '7d' | 'custom'

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '1h':     '1 Hour',
  '6h':     '6 Hours',
  '24h':    '24 Hours',
  '7d':     '7 Days',
  'custom': 'Custom',
}

// ── OID metadata ─────────────────────────────────────────────────────────────

/** Display metadata for each known OID label */
export const OID_META: Record<string, { label: string; unit: string; isCounter: boolean; isStatus: boolean }> = {
  ifInOctets:        { label: 'In Traffic',        unit: 'B/s',    isCounter: true,  isStatus: false },
  ifOutOctets:       { label: 'Out Traffic',        unit: 'B/s',    isCounter: true,  isStatus: false },
  ifInUcastPkts:     { label: 'In Packets',         unit: 'pkt/s',  isCounter: true,  isStatus: false },
  ifOutUcastPkts:    { label: 'Out Packets',         unit: 'pkt/s',  isCounter: true,  isStatus: false },
  ifInErrors:        { label: 'In Errors',          unit: 'err/s',  isCounter: true,  isStatus: false },
  ifOutErrors:       { label: 'Out Errors',         unit: 'err/s',  isCounter: true,  isStatus: false },
  ifInDiscards:      { label: 'In Discards',        unit: 'pkt/s',  isCounter: true,  isStatus: false },
  ifOutDiscards:     { label: 'Out Discards',       unit: 'pkt/s',  isCounter: true,  isStatus: false },
  ifSpeedMetric:     { label: 'Interface Speed',    unit: 'bps',    isCounter: false, isStatus: false },
  ifOperStatusMetric:{ label: 'Oper Status',        unit: '',       isCounter: false, isStatus: true  },
  ifAdminStatusMetric:{ label: 'Admin Status',      unit: '',       isCounter: false, isStatus: true  },
  Status:            { label: 'Status',             unit: '',       isCounter: false, isStatus: true  },
  // 64-bit HC counters (ifXTable)
  ifHCInOctets:      { label: 'In Traffic (HC)',    unit: 'B/s',    isCounter: true,  isStatus: false },
  ifHCOutOctets:     { label: 'Out Traffic (HC)',   unit: 'B/s',    isCounter: true,  isStatus: false },
  ifHCInUcastPkts:   { label: 'In Pkts (HC)',       unit: 'pkt/s',  isCounter: true,  isStatus: false },
  ifHCOutUcastPkts:  { label: 'Out Pkts (HC)',      unit: 'pkt/s',  isCounter: true,  isStatus: false },
  // PAN-OS per-interface (panIfStatsTable)
  panIfInBytes:      { label: 'PAN In Traffic',     unit: 'B/s',    isCounter: true,  isStatus: false },
  panIfOutBytes:     { label: 'PAN Out Traffic',    unit: 'B/s',    isCounter: true,  isStatus: false },
  panIfInPkts:       { label: 'PAN In Packets',     unit: 'pkt/s',  isCounter: true,  isStatus: false },
  panIfOutPkts:      { label: 'PAN Out Packets',    unit: 'pkt/s',  isCounter: true,  isStatus: false },
  panIfInDropPkts:   { label: 'PAN In Drops',       unit: 'pkt/s',  isCounter: true,  isStatus: false },
  panIfOutDropPkts:  { label: 'PAN Out Drops',      unit: 'pkt/s',  isCounter: true,  isStatus: false },
  // PAN-OS system scalars
  panSysCpuUtilMgmt:     { label: 'Mgmt CPU %',        unit: '%',  isCounter: false, isStatus: false },
  panSysCpuUtilDataPlane:{ label: 'DataPlane CPU %',   unit: '%',  isCounter: false, isStatus: false },
  panSysMemUsed:         { label: 'Memory Used (KB)',   unit: 'KB', isCounter: false, isStatus: false },
  panSysMemAvail:        { label: 'Memory Avail (KB)',  unit: 'KB', isCounter: false, isStatus: false },
  panSessionUtilization: { label: 'Session Util %',    unit: '%',  isCounter: false, isStatus: false },
  panSessionMax:         { label: 'Session Max',        unit: '',   isCounter: false, isStatus: false },
  panSessionActive:      { label: 'Active Sessions',    unit: '',   isCounter: false, isStatus: false },
  panSessionActiveTcp:   { label: 'Active TCP',         unit: '',   isCounter: false, isStatus: false },
  panSessionActiveUdp:   { label: 'Active UDP',         unit: '',   isCounter: false, isStatus: false },
  panSessionActiveICMP:  { label: 'Active ICMP',        unit: '',   isCounter: false, isStatus: false },
  // Generic HOST-RESOURCES-MIB system scalars/tables
  hrProcessorLoad:       { label: 'CPU Load (%)',       unit: '%',  isCounter: false, isStatus: false },
  hrMemorySize:          { label: 'Memory (KB)',        unit: 'KB', isCounter: false, isStatus: false },
  hrStorageUsed:         { label: 'Storage Used (blocks)', unit: '', isCounter: false, isStatus: false },
}

// ── Alert rule types for SNMP ─────────────────────────────────────────────────

export type SnmpAlertRuleType =
  // Existing
  | 'device_down'
  | 'unknown_trap_source'
  // New metric-based
  | 'metric_threshold'
  | 'metric_spike'
  | 'interface_down'
  | 'interface_flap'
  | 'error_rate'
  | 'discard_rate'
  | 'high_error_ratio'
  | 'bandwidth_utilization'
  | 'speed_change'
  | 'collector_gap'
  | 'device_unreachable'
  | 'trap_received'

export interface SnmpAlertRule {
  id: number
  name: string
  description: string
  enabled: boolean
  rule_type: SnmpAlertRuleType
  conditions: Record<string, unknown>
  time_window_min: number
  severity: 'info' | 'warning' | 'critical'
  channels: string[]
  cooldown_min: number
  last_fired: string | null
  created_at: string
  updated_at: string
  builtin?: boolean
}

/** One interface from GET /devices/{id}/interfaces.
 *  interface_label = ifDescr value from otelcol attribute, used as the unique key.
 */
export interface DeviceInterface {
  interface_label: string   // e.g. "eth0" — the raw ifName/ifDescr, always present
  name: string              // ifAlias description when one is set, else interface_label
  description: string | null // ifAlias, only when it differs from interface_label
  oper_status: 'up' | 'down' | 'unknown'
  admin_status: 'up' | 'down' | 'unknown'
  speed_mbps: number | null
  if_type: string | null
  mac: string | null
}

/** Latest metric snapshot for one OID on a device */
export interface MetricSnapshot {
  value: string | null
  value_numeric: number | null
  value_type: string | null
  polled_at: string
}

/** One device's card data from GET /snmp/metrics/overview */
export interface DeviceMetricsCard {
  device: {
    id: number
    name: string
    ip: string
    device_type: string
    status: string        // 'up' | 'down' | 'unknown'
    org: string
    groups: string
    site: string
    enabled: boolean
    last_seen: string | null
  }
  latest: Record<string, MetricSnapshot>  // keyed by oid_label
  has_data: boolean
  has_interfaces: boolean
}

export const SNMP_RULE_TYPE_LABELS: Record<SnmpAlertRuleType, string> = {
  device_down:          'Device Unreachable',
  unknown_trap_source:  'Unknown Trap Source',
  metric_threshold:     'Metric Threshold',
  metric_spike:         'Metric Spike (vs. baseline)',
  interface_down:       'Interface Down',
  interface_flap:       'Interface Flap',
  error_rate:           'Error Rate',
  discard_rate:         'Discard Rate',
  high_error_ratio:     'High Error Ratio (%)',
  bandwidth_utilization:'Bandwidth Utilization (%)',
  speed_change:         'Interface Speed Change',
  collector_gap:        'Collector Data Gap',
  device_unreachable:   'Device Poll Gap',
  trap_received:        'Specific Trap Received',
}
