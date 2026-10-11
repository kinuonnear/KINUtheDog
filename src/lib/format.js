// Amount helpers. On-chain amounts are integer strings that can exceed
// Number.MAX_SAFE_INTEGER, so conversions go through BigInt / strings.

export function toBigInt(value) {
  try {
    return BigInt(String(value ?? '0').split('.')[0] || '0');
  } catch {
    return 0n;
  }
}

/** "1.5" + 24 decimals -> "1500000000000000000000000". Throws on bad input. */
export function parseUnits(value, decimals) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    throw new Error('Invalid amount');
  }
  const [whole = '0', fraction = ''] = text.split('.');
  const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}

export function tryParseUnits(value, decimals) {
  try {
    return parseUnits(value, decimals);
  } catch {
    return null;
  }
}

/** Raw integer string -> exact decimal string (no rounding). */
export function formatUnits(raw, decimals) {
  const value = toBigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (!decimals) return `${negative ? '-' : ''}${abs}`;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Raw integer string -> JS number (lossy, for display/USD math only). */
export function toNumber(raw, decimals) {
  const n = Number(formatUnits(raw, decimals));
  return Number.isFinite(n) ? n : 0;
}

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2
});

/** Human-friendly token amount with adaptive precision. */
export function formatAmount(value, { compactAbove = 1e6 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= compactAbove) return compact.format(n);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (abs >= 0.0001) return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  // Tiny values (meme-token prices): plain decimals with 4 significant digits.
  const digits = Math.min(20, Math.ceil(-Math.log10(abs)) + 3);
  return n.toFixed(digits).replace(/0+$/, '');
}

export function formatRawAmount(raw, decimals, options) {
  return formatAmount(toNumber(raw, decimals), options);
}

export function formatUsd(value, { compactAbove = 1e6 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  if (abs >= compactAbove) return `$${compact.format(n)}`;
  if (abs >= 1) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  if (abs < 0.000001) return '<$0.000001';
  return `$${n.toPrecision(3)}`;
}

/** Token price: keeps significant digits for very small prices. */
export function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  return `$${formatAmount(n)}`;
}

export function formatPercent(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n !== 0 && Math.abs(n) < 0.01) return `${n < 0 ? '-' : ''}<0.01%`;
  return `${n.toFixed(digits)}%`;
}

export function shortAccount(account, head = 8, tail = 6) {
  if (!account) return '';
  return account.length > head + tail + 3
    ? `${account.slice(0, head)}…${account.slice(-tail)}`
    : account;
}

/** Apply slippage (percent) to a raw amount: amount * (1 - slippage%). */
export function applySlippage(raw, slippagePercent) {
  const bps = BigInt(Math.round(Number(slippagePercent) * 100));
  return ((toBigInt(raw) * (10000n - bps)) / 10000n).toString();
}

export function minBig(a, b) {
  return a < b ? a : b;
}

export function maxBig(a, b) {
  return a > b ? a : b;
}
