// Transfer tax on tokens launched with a tax (e.g. nearlytrade tokens such as KINU).
// Such a token exposes `get_tax` → { tax: { buy_bps, sell_bps, pairs, exempt } }: every transfer
// INTO one of `pairs` (e.g. the Rhea CLMM contract) loses `sell_bps`, every transfer OUT of one
// loses `buy_bps`, and the receiver is only credited what is left. Swaps, deposits and the
// tokens a position pays out all cross that line, so every amount KINU plans with must be net.

import { CONTRACTS } from '../config.js';
import { view } from './rpc.js';
import { toBigInt } from './format.js';

const TAX_TTL_MS = 10 * 60_000;
const cache = new Map(); // tokenId -> { at, promise }

const NONE = null;

/** The token's tax rules, or null for an ordinary token (cached for 10 minutes). */
export function getTokenTax(tokenId) {
  if (!tokenId || tokenId === CONTRACTS.wrapNear) return Promise.resolve(NONE);
  const hit = cache.get(tokenId);
  if (hit && Date.now() - hit.at < TAX_TTL_MS) return hit.promise;
  const promise = view(tokenId, 'get_tax', {})
    .then((result) => {
      const tax = result?.tax;
      if (!tax) return NONE;
      const buyBps = Number(tax.buy_bps) || 0;
      const sellBps = Number(tax.sell_bps) || 0;
      if (!buyBps && !sellBps) return NONE;
      return { buyBps, sellBps, pairs: new Set(tax.pairs || []), exempt: new Set(tax.exempt || []) };
    })
    // No get_tax method: an ordinary token. Other failures (RPC) are not cached.
    .catch((error) => {
      if (/MethodNotFound|CodeDoesNotExist|does not exist/i.test(error?.message || '')) return NONE;
      cache.delete(tokenId);
      return NONE;
    });
  cache.set(tokenId, { at: Date.now(), promise });
  return promise;
}

/** Basis points a transfer of the token loses between `from` and `to`. */
export function taxBps(tax, { from, to }) {
  if (!tax) return 0;
  if (tax.exempt.has(from) || tax.exempt.has(to)) return 0;
  if (tax.pairs.has(to)) return tax.sellBps;
  if (tax.pairs.has(from)) return tax.buyBps;
  return 0;
}

/** What arrives of `amount` (raw) after `bps` of tax; the contract rounds the tax down. */
export function afterTax(amount, bps) {
  const a = toBigInt(amount);
  if (!bps || a <= 0n) return a;
  return a - (a * BigInt(bps)) / 10_000n;
}

/** The smallest amount to send so that at least `net` (raw) arrives. */
export function grossUp(net, bps) {
  const n = toBigInt(net);
  if (!bps || n <= 0n) return n;
  let gross = (n * 10_000n + BigInt(10_000 - bps) - 1n) / BigInt(10_000 - bps);
  while (afterTax(gross, bps) < n) gross += 1n;
  return gross;
}

/** Tax of a token on its way into / out of the CLMM contract (bps). */
export async function dclTax(tokenId) {
  const tax = await getTokenTax(tokenId);
  return {
    tax,
    into: taxBps(tax, { from: '', to: CONTRACTS.dcl }),
    out: taxBps(tax, { from: CONTRACTS.dcl, to: '' })
  };
}

/** Taxes a swap crosses: the input on its way into the pools, the output on its way out. */
export async function swapTax(tokenInId, tokenOutId) {
  const [a, b] = await Promise.all([dclTax(tokenInId), dclTax(tokenOutId)]);
  return { inBps: a.into, outBps: b.out };
}

/** "1%" style label for basis points. */
export function bpsLabel(bps) {
  return `${Number((bps / 100).toFixed(2))}%`;
}
