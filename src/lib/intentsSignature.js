// Verifies that a 1Click quote was signed by 1Click (docs: "Verify Quote Signatures"), so a deposit
// address shown to the user can't have been swapped in by a browser extension or anything between
// KINU and the API. Same rules as 1Click's own SDK (@defuse-protocol/one-click-sdk-typescript
// verifyQuoteSignature): the signed message is base58(sha256(stable JSON of the request fields +
// quote fields + timestamp)), signed with ed25519 by 1Click's manager key.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

const ONE_CLICK_MANAGER_PUB_KEY = 'reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(text) {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** JSON with keys sorted and undefined values left out (json-stable-stringify). */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stable(v))).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`;
}

const orUndefined = (v) => v || undefined;

/** The request fields 1Click signs. */
function signedRequest(r) {
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: orUndefined(r.quoteWaitingTimeMs),
    referral: orUndefined(r.referral),
    virtualChainRecipient: orUndefined(r.virtualChainRecipient),
    virtualChainRefundRecipient: orUndefined(r.virtualChainRefundRecipient),
    customRecipientMsg: orUndefined(r.customRecipientMsg)
  };
}

/** The quote fields 1Click signs (a live quote adds its deposit address and timing). */
function signedQuote(q, dry) {
  const base = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut
  };
  if (dry) return base;
  return {
    ...base,
    depositAddress: orUndefined(q.depositAddress),
    depositMemo: orUndefined(q.depositMemo),
    deadline: orUndefined(q.deadline),
    timeWhenInactive: orUndefined(q.timeWhenInactive),
    timeEstimate: orUndefined(q.timeEstimate),
    refundFee: orUndefined(q.refundFee),
    withdrawFee: orUndefined(q.withdrawFee)
  };
}

/** True when a /v0/quote response ({ quote, quoteRequest, signature, timestamp }) carries 1Click's signature. */
export function verifyQuoteSignature(response) {
  try {
    const data = stable({ ...signedRequest(response.quoteRequest), ...signedQuote(response.quote, response.quoteRequest.dry), timestamp: response.timestamp });
    const message = new TextEncoder().encode(base58Encode(sha256(new TextEncoder().encode(data))));
    const signature = base58Decode(String(response.signature).replace(/^ed25519:/, ''));
    return ed25519.verify(signature, message, base58Decode(ONE_CLICK_MANAGER_PUB_KEY));
  } catch {
    return false;
  }
}
