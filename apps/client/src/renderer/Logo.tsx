// Loom's mark: an L whose stem and foot are two pairs of threads, woven where the letter turns.
// While `working`, a light runs along every thread.
import { useId } from 'react';

// Each thread: the whole line it follows, and the parts of it that show, the rest passing under another thread.
const THREADS = [
  { line: 'M6 4V20', shown: 'M6 4V9.8M6 16.2V20' },
  { line: 'M11 4V14.8', shown: 'M11 4V14.8', accent: true },
  { line: 'M4 13H20', shown: 'M4 13H7.8M14.2 13H20' },
  { line: 'M9.2 18H20', shown: 'M9.2 18H20' },
];

/** The Loom logo, decorative beside the name. `working` animates it, for when an agent is at work. */
export function Logo({ working = false }: { working?: boolean }) {
  const id = useId();
  return (
    <svg className={`logo${working ? ' working' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      {THREADS.map((thread, i) => (
        <path key={i} className={thread.accent ? 'logo-thread accent' : 'logo-thread'} d={thread.shown} />
      ))}
      {working &&
        THREADS.map((thread, i) => (
          <g key={i}>
            {/* The light follows the whole line, and shows only where the thread does. */}
            <mask id={`${id}-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
              <path d={thread.shown} stroke="#fff" />
            </mask>
            <path className="logo-light" d={thread.line} pathLength={100} mask={`url(#${id}-${i})`} style={{ animationDelay: `${-0.4 * i}s` }} />
          </g>
        ))}
    </svg>
  );
}
