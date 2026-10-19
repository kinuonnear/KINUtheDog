// KINU Scan: automated safety checks for a NEAR token, from public data only (Intear prices API,
// FastNEAR holders, NEAR RPC, Rhea's token list, GeckoTerminal / DexScreener profiles). Each check
// passes, warns or fails; the score starts at 100 and loses points per warning / failure.
// These are signals, not a guarantee: the UI says so next to the result.

import { rpc } from './rpc.js';
import { fetchTokenInfo, fetchTrades } from './intear.js';
import { getTopHolders, getTokenProfile } from './tokenMarket.js';
import { getPrices, getToken, getWhitelistedTokens } from './tokens.js';
import { formatUsd } from './format.js';
import { CONTRACTS, KINU_TOKEN } from '../config.js';

const DAY = 86_400_000;
const PENALTY = { fail: 25, warn: 10, info: 0, pass: 0 };

// Accounts whose balances are liquidity or protocol custody, not a holder who can dump.
const POOL_ACCOUNTS = new Set([
  'v2.ref-finance.near',
  'dclv2.ref-labs.near',
  'dex.intear.near',
  'intents.near',
  'burrow.near',
  'contract.main.burrow.near',
  'aurora',
  'factory.bridge.near',
  'boostfarm.ref-labs.near',
  'meme-farming_011.ref-labs.near'
]);
const isPoolAccount = (id) => POOL_ACCOUNTS.has(id) || /(^|\.)ref-finance\.near$|(^|\.)ref-labs\.near$|(^|\.)intear\.near$/.test(id);

const pct = (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** How many full-access keys the token's account has: 0 means its code can't be changed by a key holder. */
async function fullAccessKeys(tokenId) {
  const res = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: tokenId });
  return (res?.keys || []).filter((k) => k.access_key?.permission === 'FullAccess').length;
}

const settle = (p) => p.then((v) => v).catch(() => undefined);

/**
 * Scans a token: { score, verdict: 'ok' | 'caution' | 'risky', checks: [{ key, label, status, detail }], facts }.
 * Checks whose data could not be loaded are left out (and said so in `missing`).
 */
export async function scanToken(tokenId) {
  const [meta, info, holders, sells, keys, whitelist, profile] = await Promise.all([
    settle(getToken(tokenId)),
    settle(fetchTokenInfo(tokenId)),
    settle(getTopHolders(tokenId)),
    settle(fetchTrades({ tokenId, side: 'sell', limit: 50 })),
    settle(fullAccessKeys(tokenId)),
    settle(getWhitelistedTokens()),
    settle(getTokenProfile(tokenId))
  ]);
  const checks = [];
  const missing = [];
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail });
  const listed = Boolean(whitelist?.includes(tokenId));
  const base = tokenId === CONTRACTS.wrapNear || tokenId === KINU_TOKEN;

  // 1. Name: a well-known symbol on a different contract is the classic fake.
  if (meta?.symbol && whitelist?.length && !listed) {
    const prices = await settle(getPrices());
    const symbol = meta.symbol.toUpperCase();
    const twin = whitelist.find((id) => id !== tokenId && prices?.get(id)?.symbol?.toUpperCase() === symbol);
    if (twin) add('name', 'Name', 'fail', `Uses the symbol ${meta.symbol}, already taken by ${twin} on Rhea’s token list. Check the contract.`);
  }
  if (meta?.symbol?.toUpperCase() === 'KINU' && tokenId !== KINU_TOKEN) add('name', 'Name', 'fail', `Not the official $KINU (${KINU_TOKEN}).`);

  // 2. Contract: can someone with a key replace the code (mint, freeze, drain)?
  if (keys === undefined) missing.push('contract');
  else if (keys === 0) add('contract', 'Contract', 'pass', 'Locked: no full-access keys, so nobody can swap its code with a key.');
  else
    add(
      'contract',
      'Contract',
      listed ? 'info' : 'warn',
      `${keys} full-access key${keys === 1 ? '' : 's'}: the owner can change the contract (new code could mint or freeze tokens).${listed ? ' Common for established tokens run by a team.' : ''}`
    );

  // 3. Holders: how much the largest wallets (pools and protocols left out) hold.
  const total = info?.totalSupply;
  const dec = info?.decimals ?? meta?.decimals;
  if (!holders?.length || !total || dec === undefined) missing.push('holders');
  else {
    const people = holders.filter((h) => !isPoolAccount(h.account) && h.account !== tokenId);
    const share = (h) => (Number(h.balance) / 10 ** dec / total) * 100;
    const top10 = people.slice(0, 10).reduce((s, h) => s + share(h), 0);
    const largest = people[0] ? share(people[0]) : 0;
    const status = top10 > 60 || largest > 40 ? 'fail' : top10 > 35 || largest > 15 ? 'warn' : 'pass';
    add(
      'holders',
      'Top holders',
      status,
      `Top 10 wallets hold ${pct(top10)} of the supply; the largest ${pct(largest)}${people[0] ? ` (${people[0].account.length > 24 ? `${people[0].account.slice(0, 8)}…` : people[0].account})` : ''}. Pools and protocols not counted.`
    );
  }
  if (info?.holders) add('holdercount', 'Holders', info.holders < 50 ? 'warn' : 'pass', `${info.holders.toLocaleString()} holders.`);

  // 4. Liquidity: what sellers can actually get out.
  if (info) {
    const liq = info.liquidityUsd || 0;
    add('liquidity', 'Liquidity', liq < 1_000 ? 'fail' : liq < 20_000 ? 'warn' : 'pass', `${formatUsd(liq)} in pools.${liq < 1_000 ? ' Selling even a little can crash the price.' : ''}`);
    const mcap = info.price && info.circulatingSupply ? info.price * info.circulatingSupply : null;
    if (mcap && liq && !base) {
      const ratio = (liq / mcap) * 100;
      if (ratio < 2) add('depth', 'Liquidity vs market cap', 'warn', `Pools hold ${pct(ratio)} of the ${formatUsd(mcap, { compactAbove: 1e3 })} market cap: large holders can’t exit without moving the price.`);
    }
    // 5. Age.
    if (info.createdAt) {
      const age = Date.now() - info.createdAt;
      const days = Math.floor(age / DAY);
      add('age', 'Age', age < DAY ? 'warn' : age < 7 * DAY ? 'info' : 'pass', age < DAY ? 'Under 24 hours old.' : `${days.toLocaleString()} day${days === 1 ? '' : 's'} old.`);
    }
    if (!(info.volume24hUsd > 0)) add('activity', 'Trading', 'warn', 'No trades in the last 24 hours.');
  } else missing.push('market');

  // 6. Can people sell? Several different sellers lately means it's not a honeypot.
  if (sells === undefined) missing.push('sells');
  else {
    const recent = sells.filter((t) => Date.now() - t.time < 7 * DAY);
    const sellers = new Set(recent.map((t) => t.trader)).size;
    if (sellers >= 3) add('sells', 'Sell test', 'pass', `${sellers} different wallets sold in the last 7 days.`);
    else if (sellers > 0) add('sells', 'Sell test', 'warn', `Only ${sellers} wallet${sellers === 1 ? '' : 's'} sold in the last 7 days.`);
    else add('sells', 'Sell test', info?.volume24hUsd > 0 ? 'fail' : 'warn', 'Nobody sold in the last 7 days: make sure you can sell before buying much.');
  }

  // 7. Listings and links.
  add('listed', 'Rhea token list', listed ? 'pass' : 'info', listed ? 'On Rhea’s token list.' : 'Not on Rhea’s token list (most new tokens aren’t).');
  if (profile) {
    const links = ['website', 'twitter', 'telegram'].filter((k) => profile[k]).length;
    add('socials', 'Project links', profile.verified ? 'pass' : links ? 'info' : 'warn', profile.verified ? 'Verified on GeckoTerminal.' : links ? `${links} public link${links === 1 ? '' : 's'} (website / X / Telegram).` : 'No website or social links found.');
  }

  const score = Math.max(0, 100 - checks.reduce((s, c) => s + PENALTY[c.status], 0));
  const fails = checks.filter((c) => c.status === 'fail').length;
  const verdict = fails >= 2 || score < 50 ? 'risky' : fails || score < 75 ? 'caution' : 'ok';
  const order = { fail: 0, warn: 1, pass: 2, info: 3 };
  checks.sort((a, b) => order[a.status] - order[b.status]);
  return { tokenId, symbol: meta?.symbol || null, score, verdict, checks, missing, at: Date.now() };
}

export const VERDICT_LABEL = { ok: 'Looks OK', caution: 'Caution', risky: 'High risk' };
