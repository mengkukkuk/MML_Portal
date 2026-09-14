/** Shared MML emblem; the containing surface controls its size and hover motion. */
export default function MmlLogo({ className, orbitClassName }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle className={orbitClassName} cx="32" cy="32" r="27" stroke="currentColor" strokeWidth="1.5" strokeDasharray="32 10 5 10" />
      <path d="M13 41V23L19 32L25 23V41M30 41V23L36 32L42 23V41M47 23V41H53" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="round" />
      <path d="M32 5V12M32 52V59" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
