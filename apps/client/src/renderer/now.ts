import { useEffect, useState } from 'react';

/** How often the times shown are brought up to date. */
const TICK_MS = 60_000;

/** The time now, brought up to date every minute: for times shown relative to it. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
