// Max slippage picker: presets + a custom value. The value is the app-wide setting
// (useApp().slippage, saved in this browser), so it applies to every swap and liquidity action.

import { useState } from 'react';

const PRESETS = [0.1, 0.5, 1, 3];

/**
 * `auto` / `setAuto` (optional, Swap only) add an "Auto" choice: the swap picks its own slippage
 * from the pair (`autoValue`, shown under the picker). Choosing a value turns Auto off.
 */
export function SlippagePicker({ slippage, setSlippage, compact = false, auto, setAuto, autoValue }) {
  const isPreset = PRESETS.includes(Number(slippage));
  const [custom, setCustom] = useState(isPreset ? '' : String(slippage));
  const hasAuto = typeof setAuto === 'function';
  const choose = (value) => {
    setSlippage(value);
    if (hasAuto) setAuto(false);
  };

  return (
    <div className={`slippage-picker ${compact ? 'slippage-picker--compact' : ''}`}>
      <div className="segmented segmented--full">
        {hasAuto && (
          <button type="button" className={auto ? 'active' : ''} onClick={() => setAuto(true)} title="Picked from the pair: tight for stablecoins, more room for small tokens">
            Auto
          </button>
        )}
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className={!(hasAuto && auto) && Number(slippage) === value && !custom ? 'active' : ''}
            onClick={() => {
              choose(value);
              setCustom('');
            }}
          >
            {value}%
          </button>
        ))}
      </div>
      <label className={`input-inline ${custom ? 'input-inline--active' : ''}`}>
        <input
          inputMode="decimal"
          placeholder="Custom"
          value={custom}
          aria-label="Custom max slippage in percent"
          onChange={(event) => {
            const text = event.target.value.replace(',', '.');
            if (!/^\d*\.?\d*$/.test(text)) return;
            setCustom(text);
            const n = Number(text);
            if (n > 0 && n <= 50) choose(n);
          }}
        />
        <span>%</span>
      </label>
      {hasAuto && auto && autoValue != null && (
        <p className="muted small">Auto: {autoValue}% for this pair (0.2% stablecoins · 0.5% major assets · 1% other tokens).</p>
      )}
      {!(hasAuto && auto) && Number(slippage) > 5 && <p className="warning-text">High slippage: you may receive much less.</p>}
      {!(hasAuto && auto) && Number(slippage) < 0.3 && <p className="warning-text">Very low slippage: the transaction may fail if the price moves.</p>}
    </div>
  );
}
