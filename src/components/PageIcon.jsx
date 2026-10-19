// The icon tile beside a page title (.pt-title): a glass square with a mint line icon.

const PATHS = {
  // Earn: a coin stack with a sprout
  earn: (
    <>
      <ellipse cx="10" cy="15" rx="6" ry="2.5" />
      <path d="M4 15v3c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-3" />
      <path d="M17 12V8" />
      <path d="M17 8c0-2.5 1.8-4 4-4 0 2.5-1.8 4-4 4z" />
      <path d="M17 9.5c0-1.9-1.4-3-3-3 0 1.9 1.4 3 3 3z" />
    </>
  ),
  // Bridge: an arc between two chains
  bridge: (
    <>
      <path d="M3 17h18" />
      <path d="M5 17v-3a7 7 0 0 1 14 0v3" />
      <path d="M9 17v-2.5M15 17v-2.5M12 17v-3.5" />
    </>
  ),
  // Pool Analysis: depth bars with a level line
  analysis: (
    <>
      <path d="M4 20V13M9 20V8M14 20v-5M19 20V10" />
      <path d="M2.5 11h19" strokeDasharray="2 2.5" />
    </>
  ),
  // Pools: a drop with a ripple
  pools: (
    <>
      <path d="M12 3.5c3 3.6 5 6.4 5 9a5 5 0 0 1-10 0c0-2.6 2-5.4 5-9z" />
      <path d="M3 20c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0" />
    </>
  ),
  // Agent: a spark with an orbit
  agent: (
    <>
      <path d="M12 4.5l1.6 4.2 4.2 1.6-4.2 1.6L12 16.1l-1.6-4.2-4.2-1.6 4.2-1.6z" />
      <path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
      <path d="M4.5 18.5a10 10 0 0 0 7.5 2" />
    </>
  ),
  // Portfolio: a pie chart
  portfolio: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z" />
      <path d="M15 3.8A8.6 8.6 0 0 1 20.2 9H15z" />
    </>
  ),
  // Discover: a compass
  discover: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
  // Treasury: a vault door
  treasury: (
    <>
      <rect x="3.5" y="4" width="17" height="15" rx="2.5" />
      <circle cx="12" cy="11.5" r="3.5" />
      <path d="M12 8v1.2M12 13.8V15M8.5 11.5h1.2M14.3 11.5h1.2" />
      <path d="M6.5 19v1.5M17.5 19v1.5" />
    </>
  ),
  // NEAR DeFi Pulse: a heartbeat line over a baseline
  pulse: (
    <>
      <path d="M3 12h4l2-5 3.5 10 2.5-7 1.5 2H21" />
      <path d="M3 20h18" />
    </>
  )
};

export default function PageIcon({ name }) {
  return (
    <span className="pt-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {PATHS[name]}
      </svg>
    </span>
  );
}
