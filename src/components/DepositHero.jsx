// The /deposit hero: chains on the left stream light along curved beams into a glowing NEAR core.
// Pure SVG; the travelling sparks are SMIL animations, left out when the visitor prefers reduced
// motion.

import { useMemo } from 'react';
import { chainIcon, CHAIN_NAMES, RECEIVE_ICONS } from '../lib/intents.js';

const SOURCES = ['eth', 'base', 'sol', 'arb', 'bsc', 'btc', 'tron'];
const W = 520;
const H = 300;
const CORE = { x: 400, y: 150 };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function DepositHero({ chainCount }) {
  const still = useMemo(reducedMotion, []);
  const nodes = SOURCES.map((id, i) => {
    const t = i / (SOURCES.length - 1);
    // An arc on the left: the middle chains sit further out.
    const y = 34 + t * (H - 68);
    // Room on the left for the chain names (right-aligned up to the logo).
    const x = 128 - Math.sin(t * Math.PI) * 30;
    return { id, x, y, path: `M${x + 18} ${y} C ${x + 140} ${y}, ${CORE.x - 150} ${CORE.y + (y - CORE.y) * 0.25}, ${CORE.x - 44} ${CORE.y}` };
  });

  return (
    <div className="dep-hero__visual" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
        <defs>
          <radialGradient id="dh-core" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#b8ff3d" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="#3ddc97" stopOpacity="0.16" />
            <stop offset="1" stopColor="#3ddc97" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="dh-beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#5ec8ff" stopOpacity="0.05" />
            <stop offset="0.6" stopColor="#5ec8ff" stopOpacity="0.35" />
            <stop offset="1" stopColor="#b8ff3d" stopOpacity="0.8" />
          </linearGradient>
          <filter id="dh-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {nodes.map((n) => (
            <clipPath key={n.id} id={`dh-clip-${n.id}`}>
              <circle cx={n.x} cy={n.y} r="16" />
            </clipPath>
          ))}
          <clipPath id="dh-clip-core">
            <circle cx={CORE.x} cy={CORE.y} r="34" />
          </clipPath>
        </defs>

        {/* faint grid */}
        <g stroke="rgba(200,220,255,0.05)" strokeWidth="1">
          {Array.from({ length: 9 }, (_, i) => (
            <line key={`v${i}`} x1={i * 65} y1="0" x2={i * 65} y2={H} />
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 60} x2={W} y2={i * 60} />
          ))}
        </g>

        {/* beams */}
        {nodes.map((n, i) => (
          <g key={n.id}>
            <path id={`dh-path-${n.id}`} d={n.path} fill="none" stroke="url(#dh-beam)" strokeWidth="1.6" />
            {!still && (
              <circle r="3" fill="#e9ffb8" filter="url(#dh-glow)">
                <animateMotion dur={`${2.4 + (i % 3) * 0.5}s`} begin={`${i * 0.37}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
                  <mpath href={`#dh-path-${n.id}`} />
                </animateMotion>
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur={`${2.4 + (i % 3) * 0.5}s`} begin={`${i * 0.37}s`} repeatCount="indefinite" />
              </circle>
            )}
          </g>
        ))}

        {/* NEAR core */}
        <circle cx={CORE.x} cy={CORE.y} r="110" fill="url(#dh-core)">
          {!still && <animate attributeName="r" values="100;118;100" dur="4s" repeatCount="indefinite" />}
        </circle>
        <circle cx={CORE.x} cy={CORE.y} r="52" fill="none" stroke="rgba(184,255,61,0.35)" strokeWidth="1.5" strokeDasharray="3 6">
          {!still && <animateTransform attributeName="transform" type="rotate" from={`0 ${CORE.x} ${CORE.y}`} to={`360 ${CORE.x} ${CORE.y}`} dur="24s" repeatCount="indefinite" />}
        </circle>
        <circle cx={CORE.x} cy={CORE.y} r="40" fill="#05080d" stroke="#b8ff3d" strokeWidth="2" filter="url(#dh-glow)" />
        <image href={RECEIVE_ICONS.near} x={CORE.x - 34} y={CORE.y - 34} width="68" height="68" clipPath="url(#dh-clip-core)" />
        <text x={CORE.x} y={CORE.y + 72} textAnchor="middle" fill="#e6edf5" fontSize="12" fontWeight="700" letterSpacing="2">
          NEAR
        </text>

        {/* chains */}
        {nodes.map((n) => (
          <g key={`n-${n.id}`}>
            <circle cx={n.x} cy={n.y} r="20" fill="#0b0f16" stroke="rgba(200,220,255,0.18)" strokeWidth="1.2" />
            {chainIcon(n.id) && <image href={chainIcon(n.id)} x={n.x - 16} y={n.y - 16} width="32" height="32" clipPath={`url(#dh-clip-${n.id})`} />}
            <text x={n.x - 28} y={n.y + 4} textAnchor="end" fill="#8a96a8" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {CHAIN_NAMES[n.id]}
            </text>
          </g>
        ))}
        <text x="16" y={H - 6} fill="#5b6678" fontSize="10" fontFamily="JetBrains Mono, monospace">
          +{Math.max(0, chainCount - SOURCES.length) || 29} more chains
        </text>
      </svg>
    </div>
  );
}
