/**
 * The agent's face: a KINU-style robot shiba (ears, green bandana) with a blinking visor and a
 * scan line that runs faster while a scan is in progress. Pure SVG + CSS, no image files.
 */
export function AgentBot({ scanning }) {
  return (
    <div className={`ag-bot ${scanning ? 'ag-bot--scanning' : ''}`} aria-hidden>
      <svg viewBox="0 0 120 124" width="104" height="108">
        <defs>
          <linearGradient id="agHead" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2a3446" />
            <stop offset="1" stopColor="#141a24" />
          </linearGradient>
          <linearGradient id="agBand" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b8ff3d" />
            <stop offset="1" stopColor="#3ddc97" />
          </linearGradient>
          <clipPath id="agVisor">
            <rect x="30" y="47" width="60" height="26" rx="13" />
          </clipPath>
        </defs>
        {/* antenna */}
        <line x1="60" y1="14" x2="60" y2="30" stroke="#7d8798" strokeWidth="3" strokeLinecap="round" />
        <circle className="ag-bot__beacon" cx="60" cy="11" r="5" fill="#b8ff3d" />
        {/* shiba ears */}
        <path d="M24 46 L30 18 L50 34 Z" fill="url(#agHead)" stroke="#3a4558" strokeWidth="2" strokeLinejoin="round" />
        <path d="M96 46 L90 18 L70 34 Z" fill="url(#agHead)" stroke="#3a4558" strokeWidth="2" strokeLinejoin="round" />
        <path d="M31 38 L33 26 L42 33 Z" fill="#b8ff3d" opacity="0.55" />
        <path d="M89 38 L87 26 L78 33 Z" fill="#b8ff3d" opacity="0.55" />
        {/* head */}
        <rect x="18" y="30" width="84" height="64" rx="24" fill="url(#agHead)" stroke="#3a4558" strokeWidth="2" />
        {/* visor with eyes and the scan line */}
        <rect x="30" y="47" width="60" height="26" rx="13" fill="#070a0f" stroke="rgba(184,255,61,0.35)" strokeWidth="1.5" />
        <g clipPath="url(#agVisor)">
          <g className="ag-bot__eyes">
            <rect x="42" y="55" width="10" height="10" rx="5" fill="#b8ff3d" />
            <rect x="68" y="55" width="10" height="10" rx="5" fill="#b8ff3d" />
          </g>
          <rect className="ag-bot__scan" x="30" y="47" width="10" height="26" fill="rgba(94,200,255,0.45)" />
        </g>
        {/* cheek lights */}
        <circle cx="27" cy="72" r="2.5" fill="#3ddc97" opacity="0.7" />
        <circle cx="93" cy="72" r="2.5" fill="#3ddc97" opacity="0.7" />
        {/* mouth grill */}
        <path d="M50 82 H70" stroke="#5b6678" strokeWidth="2.5" strokeLinecap="round" />
        {/* KINU bandana */}
        <path d="M30 94 Q60 104 90 94 L60 120 Z" fill="url(#agBand)" />
        <path d="M54 102 L60 96 L66 102 L60 110 Z" fill="#0b1204" opacity="0.55" />
      </svg>
    </div>
  );
}
