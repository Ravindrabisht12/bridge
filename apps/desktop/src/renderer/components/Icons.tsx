/** Inline 16px stroke icons — no icon dependency, no remote fetch, CSP-safe. */
interface P {
  size?: number
  className?: string
}

const svg = (path: JSX.Element, { size = 16, className }: P): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {path}
  </svg>
)

export const IconPulse = (p: P): JSX.Element => svg(<path d="M1 8h3l2-5 3 10 2-5h4" />, p)
export const IconGrid = (p: P): JSX.Element =>
  svg(
    <>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
    </>,
    p
  )
export const IconServer = (p: P): JSX.Element =>
  svg(
    <>
      <rect x="1.5" y="2" width="13" height="5" rx="1.4" />
      <rect x="1.5" y="9" width="13" height="5" rx="1.4" />
      <path d="M4.2 4.5h.01M4.2 11.5h.01" />
    </>,
    p
  )
export const IconTool = (p: P): JSX.Element =>
  svg(<path d="M10.4 1.6a3.6 3.6 0 0 0-4.3 4.7L1.8 10.6a1.5 1.5 0 1 0 2.1 2.1l4.3-4.3a3.6 3.6 0 0 0 4.7-4.3l-2 2-1.6-1.6 2-1.6z" />, p)
export const IconShield = (p: P): JSX.Element =>
  svg(
    <>
      <path d="M8 1.5 2.8 3.6v3.6c0 3.2 2.1 6 5.2 7.3 3.1-1.3 5.2-4.1 5.2-7.3V3.6L8 1.5z" />
      <path d="M6 7.8 7.4 9.3 10.2 6.2" />
    </>,
    p
  )
export const IconSettings = (p: P): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3" />
    </>,
    p
  )
export const IconSearch = (p: P): JSX.Element =>
  svg(
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>,
    p
  )
export const IconAlert = (p: P): JSX.Element =>
  svg(
    <>
      <path d="M8 1.8 1.3 13.4h13.4L8 1.8z" />
      <path d="M8 6.2v3.1M8 11.4h.01" />
    </>,
    p
  )
export const IconInfo = (p: P): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.2v3.6M8 5.2h.01" />
    </>,
    p
  )
export const IconClose = (p: P): JSX.Element => svg(<path d="m4 4 8 8M12 4l-8 8" />, p)
export const IconSun = (p: P): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1" />
    </>,
    p
  )
export const IconMoon = (p: P): JSX.Element => svg(<path d="M13.5 9.4A5.8 5.8 0 0 1 6.6 2.5a5.8 5.8 0 1 0 6.9 6.9z" />, p)
export const IconExport = (p: P): JSX.Element =>
  svg(
    <>
      <path d="M8 10.5V2.2M5.2 5l2.8-2.8L10.8 5" />
      <path d="M2.5 10v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
    </>,
    p
  )
export const IconPause = (p: P): JSX.Element => svg(<path d="M6 3v10M10 3v10" />, p)
export const IconPlay = (p: P): JSX.Element => svg(<path d="M4.5 2.8v10.4L13 8z" />, p)
export const IconBolt = (p: P): JSX.Element => svg(<path d="M9 1.5 3.2 9h4L7 14.5 12.8 7h-4L9 1.5z" />, p)
export const IconVerified = ({ size = 14, className }: P): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    {/* A scalloped seal, so "official" reads as a mark rather than a tick. */}
    <path
      d="M8 1.1l1.36.95 1.65-.15.62 1.54 1.44.83-.5 1.58.5 1.58-1.44.83-.62 1.54-1.65-.15L8 10.6l-1.36-.95-1.65.15-.62-1.54-1.44-.83.5-1.58-.5-1.58 1.44-.83.62-1.54 1.65.15L8 1.1z"
      fill="currentColor"
      opacity="0.16"
    />
    <path
      d="M8 1.1l1.36.95 1.65-.15.62 1.54 1.44.83-.5 1.58.5 1.58-1.44.83-.62 1.54-1.65-.15L8 10.6l-1.36-.95-1.65.15-.62-1.54-1.44-.83.5-1.58-.5-1.58 1.44-.83.62-1.54 1.65.15L8 1.1z"
      stroke="currentColor"
      strokeWidth="1.1"
    />
    <path d="M5.9 5.9l1.5 1.5 2.7-2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const IconPlus = (p: P): JSX.Element => svg(<path d="M8 3.5v9M3.5 8h9" />, p)
export const IconCheck = (p: P): JSX.Element => svg(<path d="m3 8.5 3.2 3.2L13 4.8" />, p)
export const IconExternal = (p: P): JSX.Element =>
  svg(
    <>
      <path d="M6.5 3.2h6.3v6.3" />
      <path d="M12.8 3.2 6.2 9.8" />
      <path d="M11 9.6v3.2H3.2V5h3.2" />
    </>,
    p
  )
export const IconCopy = (p: P): JSX.Element =>
  svg(
    <>
      <rect x="5.6" y="5.6" width="8" height="8" rx="1.4" />
      <path d="M10.4 5.6V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5a1.4 1.4 0 0 0 1.4 1.4h1.6" />
    </>,
    p
  )
export const IconLibrary = (p: P): JSX.Element =>
  svg(
    <>
      <rect x="1.6" y="2.4" width="3.2" height="11.2" rx="1" />
      <rect x="6.4" y="2.4" width="3.2" height="11.2" rx="1" />
      <path d="M11.4 3.4l2.6.7-2.2 9.6-2.6-.7" />
    </>,
    p
  )
export const IconChevron = (p: P): JSX.Element => svg(<path d="m6 3.5 5 4.5-5 4.5" />, p)
export const IconBridge = ({ size = 18 }: P): JSX.Element => (
  // Drawn for this size rather than scaled down from the app icon: at 18px the
  // side cables and the deck ends collapse into each other, so the small mark
  // keeps only the parts that still read — two towers, the sag between them,
  // and the deck.
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <g stroke="var(--accent)" fill="none" strokeLinecap="round">
      <path d="M6.4 5.6Q10 13.4 13.6 5.6" strokeWidth="1.5" />
      <path d="M6.4 4.9V14.9" strokeWidth="1.7" />
      <path d="M13.6 4.9V14.9" strokeWidth="1.7" />
      <path d="M2.4 12.1H17.6" strokeWidth="1.7" />
    </g>
  </svg>
)
