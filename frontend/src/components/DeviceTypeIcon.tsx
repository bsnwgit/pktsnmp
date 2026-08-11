/**
 * Device-type glyphs in the Foundation language.
 *
 * These were colour emoji (🔥 🔀 📡 …), which carried their own palette and
 * their own rendering — a full-colour pictograph sitting on a hairline console
 * reads as a sticker on an instrument. These are drawn in the same idiom as
 * the app marks: 1.3px strokes, no fills, and currentColor so each caller
 * decides the colour rather than the glyph insisting on one.
 */

const P = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const GLYPHS: Record<string, JSX.Element> = {
  // brick wall — staggered courses
  firewall: (
    <>
      <path d="M3 7h18M3 12h18M3 17h18" {...P} />
      <path d="M9 7V3.5M15 12V7M9 17v-5M15 21v-4" {...P} strokeWidth={1} opacity={0.6} />
    </>
  ),
  // crossing paths
  switch: (
    <>
      <path d="M4 8h9l-2.5-2.5M13 8l-2.5 2.5" {...P} />
      <path d="M20 16H11l2.5-2.5M11 16l2.5 2.5" {...P} opacity={0.75} />
    </>
  ),
  // access point radiating
  wap: (
    <>
      <rect x="9.5" y="15" width="5" height="5" {...P} />
      <circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M8.6 12.6a5 5 0 016.8 0" {...P} />
      <path d="M6.2 9.6a8.6 8.6 0 0111.6 0" {...P} opacity={0.6} />
    </>
  ),
  // controller tower
  wlc: (
    <>
      <path d="M12 6v13M8 19h8" {...P} />
      <path d="M8.5 8.5a5 5 0 017 0" {...P} opacity={0.75} />
      <path d="M6 5.5a8.6 8.6 0 0112 0" {...P} opacity={0.45} />
      <circle cx="12" cy="6" r="1.4" {...P} />
    </>
  ),
  // routed globe
  router: (
    <>
      <circle cx="12" cy="12" r="8" {...P} />
      <path d="M4 12h16M12 4c2.4 2.2 2.4 13.8 0 16M12 4c-2.4 2.2-2.4 13.8 0 16" {...P} strokeWidth={1} opacity={0.7} />
    </>
  ),
  // chip with pins
  iot: (
    <>
      <rect x="7" y="7" width="10" height="10" {...P} />
      <rect x="10.5" y="10.5" width="3" height="3" {...P} strokeWidth={1} />
      <path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3" {...P} strokeWidth={1} opacity={0.65} />
    </>
  ),
  // battery + bolt
  ups: (
    <>
      <rect x="3.5" y="7" width="15" height="10" {...P} />
      <path d="M18.5 10.5h2v3h-2" {...P} strokeWidth={1} />
      <path d="M11.5 9l-2 3.2h2.6L10.9 15" {...P} strokeWidth={1.2} />
    </>
  ),
  // rack units
  server: (
    <>
      <rect x="3.5" y="4" width="17" height="6" {...P} />
      <rect x="3.5" y="14" width="17" height="6" {...P} />
      <path d="M6.5 7h5M6.5 17h5" {...P} strokeWidth={1} opacity={0.6} />
      <circle cx="17" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="17" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  // disc stack
  storage: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="2.8" {...P} />
      <path d="M4.5 6.5v11c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-11" {...P} />
      <path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8" {...P} strokeWidth={1} opacity={0.6} />
    </>
  ),
  // power distribution
  pdu: (
    <>
      <rect x="3" y="9" width="18" height="6" {...P} />
      <path d="M7 12h.01M11 12h.01M15 12h.01" {...P} strokeWidth={1.8} />
      <path d="M12 9V4.5M12 19.5V15" {...P} strokeWidth={1} opacity={0.6} />
    </>
  ),
  // camera body + lens
  camera: (
    <>
      <path d="M3.5 8h11l2.5 2v4l-2.5 2h-11z" {...P} />
      <circle cx="9" cy="12" r="2.4" {...P} strokeWidth={1} />
      <path d="M17 11l3.5-2v6L17 13" {...P} />
    </>
  ),
  // one in, many out
  load_balancer: (
    <>
      <path d="M12 4v6" {...P} />
      <path d="M4 20v-4a2 2 0 012-2h12a2 2 0 012 2v4" {...P} opacity={0.75} />
      <circle cx="12" cy="4.6" r="1.6" {...P} />
      <circle cx="4" cy="20" r="1.6" {...P} />
      <circle cx="12" cy="20" r="1.6" {...P} />
      <circle cx="20" cy="20" r="1.6" {...P} />
    </>
  ),
  // padlock
  vpn: (
    <>
      <rect x="5" y="10.5" width="14" height="9" {...P} />
      <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" {...P} />
      <circle cx="12" cy="15" r="1.3" {...P} strokeWidth={1} />
    </>
  ),
  // printer
  printer: (
    <>
      <path d="M7 8V4h10v4" {...P} />
      <rect x="3.5" y="8" width="17" height="7" {...P} />
      <path d="M7 15h10v5H7z" {...P} opacity={0.8} />
      <circle cx="17.5" cy="11" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  // generic node
  other: (
    <>
      <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" {...P} />
      <circle cx="12" cy="12" r="2.2" {...P} strokeWidth={1} />
    </>
  ),
}

export default function DeviceTypeIcon({
  type,
  size = 16,
  className = '',
}: {
  type?: string | null
  size?: number
  className?: string
}) {
  const glyph = GLYPHS[(type || 'other').toLowerCase()] ?? GLYPHS.other
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label={`${type || 'other'} device`}
    >
      {glyph}
    </svg>
  )
}
