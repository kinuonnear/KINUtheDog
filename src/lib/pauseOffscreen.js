// Pause CSS animations that are off screen. Looping animations (flow lines, the landing page's
// feeds and tickers) keep the browser painting even when nobody can see them, which costs CPU and
// battery on phones. An element marked `is-offscreen` pauses every animation inside it (theme.css /
// landing.css); it resumes as soon as it scrolls back into view.

import { useEffect } from 'react';

const OFFSCREEN = 'is-offscreen';
// Start a little before an element enters the viewport, so nothing visibly jumps.
const MARGIN = '120px 0px';

/** Watch these elements and mark the ones out of view. Returns a function that stops watching. */
export function pauseWhenOffscreen(elements) {
  const list = [...elements].filter(Boolean);
  if (!list.length || typeof IntersectionObserver === 'undefined') return () => {};
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.target.classList.toggle(OFFSCREEN, !e.isIntersecting)),
    { rootMargin: MARGIN }
  );
  list.forEach((el) => io.observe(el));
  return () => {
    io.disconnect();
    list.forEach((el) => el.classList.remove(OFFSCREEN));
  };
}

/** Pause the animations inside `ref`'s element while it is off screen. */
export function usePauseOffscreen(ref) {
  useEffect(() => pauseWhenOffscreen([ref.current]), [ref]);
}
