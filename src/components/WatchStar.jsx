// ☆ / ★ toggle for the watchlist. Stops the click so it works inside clickable rows.

import { useWatchlist } from '../lib/watchlist.js';

export default function WatchStar({ id, label = false }) {
  const { has, toggle } = useWatchlist();
  const on = has(id);
  return (
    <button
      type="button"
      className={`watch-star ${on ? 'watch-star--on' : ''} ${label ? 'watch-star--label' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        toggle(id);
      }}
      aria-pressed={on}
      title={on ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {on ? '★' : '☆'}
      {label && <span>{on ? 'Watching' : 'Watch'}</span>}
    </button>
  );
}
