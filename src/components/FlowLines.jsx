// Liquidity drawn as light: faint curves with a pulse travelling along each, ivory and mint.
// Used behind the landing page's headline and the app's Home hero (styles: .lx-flow in landing.css).

import { useRef } from 'react';
import { usePauseOffscreen } from '../lib/pauseOffscreen.js';
import '../landing.css';

// Liquidity drifting left to right behind the headline: faint base curves with a light pulse
// travelling along each one.
const FLOWS = [
  'M-40 330 C 260 250, 470 420, 760 330 S 1220 230, 1480 300',
  'M-40 390 C 300 330, 520 470, 800 390 S 1200 300, 1480 360',
  'M-40 270 C 240 200, 520 330, 780 260 S 1180 180, 1480 230',
  'M-40 450 C 320 410, 560 520, 820 450 S 1240 380, 1480 430',
  'M-40 210 C 280 160, 500 260, 760 200 S 1200 130, 1480 170'
];

// Bright mint, white and green: one per light, in turn.
const FLOW_COLORS = ['#8ff5bf', '#ffffff', '#5fe39d'];

export function FlowLines() {
  // The pulses stop while the header is scrolled out of view.
  const ref = useRef(null);
  usePauseOffscreen(ref);
  return (
    <svg ref={ref} className="lx-flow" viewBox="0 0 1440 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        {FLOW_COLORS.map((c, k) => (
          <linearGradient key={c} id={`lx-flow-fade-${k}`} x1="0" x2="1">
            <stop offset="0" stopColor={c} stopOpacity="0" />
            <stop offset="0.3" stopColor={c} stopOpacity="1" />
            <stop offset="0.7" stopColor={c} stopOpacity="1" />
            <stop offset="1" stopColor={c} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {FLOWS.map((d, i) => (
        <g key={i} style={{ '--i': i }}>
          <path className="lx-flow__base" d={d} />
          <path className="lx-flow__pulse" d={d} pathLength="1000" style={{ stroke: `url(#lx-flow-fade-${i % FLOW_COLORS.length})` }} />
        </g>
      ))}
    </svg>
  );
}
