/**
 * Brand — pktSNMP identity in the Foundation visual language.
 *
 * The functional idea of the original mark is preserved: the diagram still
 * says the same thing about what this app does. Only the execution changes —
 * hairline strokes and a concentric survey ring instead of filled shapes,
 * gold as the system channel, and a single ice-blue element marking the
 * live/data part of the diagram.
 */

export function BrandMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
  <circle cx="32" cy="32" r="30" stroke="rgba(216,180,110,.16)"/>
  <circle cx="32" cy="32" r="30" stroke="rgba(216,180,110,.5)" strokeDasharray="1.5 11"/>
  <path d="M32 27.5 L14 43.8" stroke="rgba(216,180,110,.45)" strokeWidth="1"/>
  <path d="M32 27.5 L50 43.8" stroke="rgba(216,180,110,.45)" strokeWidth="1"/>
  <path d="M32 27.5 L32 43.6" stroke="rgba(138,216,234,.5)" strokeWidth="1"/>
  <path d="M21.8 34.2 l2.4 2.2" stroke="rgba(216,180,110,.85)" strokeWidth="1"/>
  <path d="M42.2 34.2 l-2.4 2.2" stroke="rgba(216,180,110,.85)" strokeWidth="1"/>
  <path d="M29.4 35.4 h5.2" stroke="rgba(138,216,234,.6)" strokeWidth="1"/>
  <circle cx="32" cy="20" r="10.5" stroke="rgba(216,180,110,.24)"/>
  <circle cx="32" cy="20" r="6.4" stroke="#f5e2b6" strokeWidth="1.3"/>
  <circle cx="32" cy="20" r="2.3" fill="#f5e2b6"/>
  <circle cx="14" cy="47" r="3.4" stroke="rgba(216,180,110,.85)"/>
  <circle cx="50" cy="47" r="3.4" stroke="rgba(216,180,110,.85)"/>
  <circle cx="32" cy="47" r="3.4" stroke="#8ad8ea"/>
  <circle cx="32" cy="47" r="1.1" fill="#8ad8ea"/>
    </svg>
  )
}

/** Full lockup — mark + wordmark. Pass descriptor={null} for tight spots. */
export function BrandLockup({
  markSize = 30,
  className = '',
  descriptor = 'Telemetry',
}: {
  markSize?: number
  className?: string
  descriptor?: string | null
}) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <BrandMark size={markSize} className="flex-none" />
      <div className="leading-tight min-w-0">
        <div className="flex items-baseline gap-[3px]">
          <span className="font-mono text-[10px] text-gray-400" style={{ letterSpacing: '0.26em' }}>
            pkt
          </span>
          <span className="font-mono text-blue-300" style={{ fontSize: '15px', letterSpacing: '0.2em' }}>
            SNMP
          </span>
        </div>
        {descriptor && (
          <div className="f-lbl mt-[3px]" style={{ letterSpacing: '0.32em' }}>
            {descriptor}
          </div>
        )}
      </div>
    </div>
  )
}

export default BrandLockup
