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
  // Pools: a drop with a ripple
  pools: (
    <>
      <path d="M12 3.5c3 3.6 5 6.4 5 9a5 5 0 0 1-10 0c0-2.6 2-5.4 5-9z" />
      <path d="M3 20c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0" />
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
