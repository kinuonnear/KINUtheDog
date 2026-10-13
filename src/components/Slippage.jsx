// Max slippage picker: presets + a custom value. The value is the app-wide setting
// (useApp().slippage, saved in this browser), so it applies to every swap and liquidity action.

import { useState } from 'react';

const PRESETS = [0.1, 0.5, 1, 3];

export function SlippagePicker({ slippage, setSlippage, compact = false }) {
  const isPreset = PRESETS.includes(Number(slippage));
  const [custom, setCustom] = useState(isPreset ? '' : String(slippage));

  return (
    <div className={`slippage-picker ${compact ? 'slippage-picker--compact' : ''}`}>
      <div className="segmented segmented--full">
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className={Number(slippage) === value && !custom ? 'active' : ''}
            onClick={() => {
              setSlippage(value);
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
            if (n > 0 && n <= 50) setSlippage(n);
          }}
        />
        <span>%</span>
      </label>
      {Number(slippage) > 5 && <p className="warning-text">High slippage: you may receive much less.</p>}
      {Number(slippage) < 0.3 && <p className="warning-text">Very low slippage: the transaction may fail if the price moves.</p>}
    </div>
  );
}
