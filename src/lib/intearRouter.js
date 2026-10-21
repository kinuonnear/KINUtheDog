// Swap quotes from the Intear DEX Aggregator (router.intear.tech, docs.intear.tech/dex-aggregator).
// It searches Rhea, Rhea CLMM and Intear DEX (Plach) pools and answers with the exact
// transactions to sign. KINU passes its referrer account (config INTEAR_REFERRER); the referral
// fee is 0% today, so quotes are the same as without it.
//
// The aggregator's transactions are never signed blindly: every route is checked here against
// what a swap of exactly this input may do (which contracts, which methods, how much is spent,
// that the output goes back to the trader), and lib/txGuard.js checks them again before the wallet.

import { CONTRACTS, ENDPOINTS, INTEAR_FEE, INTEAR_REFERRER } from '../config.js';
import { feeAfterDiscount } from './holder.js';
import { toBigInt } from './format.js';
import { functionCall, transaction } from './tx.js';
import { afterTax, swapTax } from './tokenTax.js';

const QUOTE_TIMEOUT_MS = 8_000;
const MAX_WAIT_MS = 2_500; // how long the aggregator may search
// Only DEXs whose transactions KINU checks below. Others (Aidols, liquid staking) are left out.
const DEXES = ['Rhea', 'RheaDcl', 'Plach', 'Wrap'];
export const DEX_LABEL = { Rhea: 'Rhea', RheaDcl: 'Rhea CLMM', Plach: 'Intear DEX', Wrap: 'Wrap' };
// Routes on these DEXs credit KINU's referrer (docs.intear.tech/dex-aggregator/guides/referral-fees);
// Rhea CLMM and Wrap routes don't.
export const REFERRAL_DEXES = new Set(['Rhea', 'Plach']);
const MAX_GAS = 300_000_000_000_000n; // NEAR's per-transaction limit
// Intear DEX operations a swap route may contain; anything else is refused.
const PLACH_OPERATIONS = new Set(['SwapSimple', 'Withdraw']);
// Where the input token may be sent with ft_transfer_call.
const DESTINATIONS = new Set([CONTRACTS.exchange, CONTRACTS.dcl, CONTRACTS.intearDex]);
const METHODS = {
  [CONTRACTS.wrapNear]: ['near_deposit', 'near_withdraw', 'storage_deposit', 'ft_transfer_call'],
  [CONTRACTS.intearDex]: ['deposit_near', 'register_assets', 'storage_deposit']
};

// KINU's own fee on Intear routes (docs.intear.tech/dex-aggregator/guides/referral-fees): sent per
// request as `fees` (renamed from `referral_fees` before launch); on Rhea / Rhea CLMM routes it is paid by an ft_transfer of the input
// token in a fee transaction after the swap, 80% to KINU's account and 20% to Intear's protocol
// account; on Intear DEX pools it is taken on chain. Off until INTEAR_FEE.live.
const INTEAR_PROTOCOL_FEE_ACCOUNT = 'plach.intear.near';
export const INTEAR_FEE_RECIPIENTS = new Set([INTEAR_REFERRER, INTEAR_PROTOCOL_FEE_ACCOUNT]);
// Intear treats these as "stable" for its lower fee tier (NEAR, wNEAR and the main stablecoins).
const FEE_STABLE_IDS = new Set([
  'near',
  'wrap.near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'usdt.tether-token.near',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near'
]);

/** KINU's fee on an Intear route for this pair, in basis points (0 while switched off). */
export function intearFeeBps(tokenIn, tokenOut) {
  if (!INTEAR_FEE.live) return 0;
  return feeAfterDiscount(FEE_STABLE_IDS.has(tokenIn?.id) && FEE_STABLE_IDS.has(tokenOut?.id) ? INTEAR_FEE.stableBps : INTEAR_FEE.bps);
}

const contractOf = (token) => token.contract || token.id;
const assetOf = (token) => (token.native ? 'near' : `nep141:${contractOf(token)}`);

function decodeArgs(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseMsg(msg) {
  try {
    return JSON.parse(msg);
  } catch {
    return null;
  }
}

/** The aggregator's instructions as KINU transactions (lib/tx.js shape). Unknown kinds are refused. */
function toTransactions(instructions) {
  if (!Array.isArray(instructions) || !instructions.length) throw new Error('empty route');
  return instructions.map((step) => {
    const kinds = Object.keys(step || {});
    if (kinds.length !== 1 || kinds[0] !== 'NearTransaction') throw new Error(`unsupported step "${kinds.join(',')}"`);
    const { receiver_id: receiver, actions, is_fee_transaction: isFee } = step.NearTransaction;
    if (typeof receiver !== 'string' || !Array.isArray(actions) || !actions.length) throw new Error('malformed step');
    const tx = transaction(
      receiver,
      actions.map((action) => {
        const keys = Object.keys(action || {});
        if (keys.length !== 1 || keys[0] !== 'FunctionCall') throw new Error(`unsupported action "${keys.join(',')}"`);
        const { method_name: method, args, gas, deposit } = action.FunctionCall;
        return functionCall(method, decodeArgs(args), String(BigInt(gas)), String(BigInt(deposit || '0')));
      })
    );
    // Fee transactions come last and are sent only after the swap succeeded (state.jsx execute).
    return isFee === true ? { ...tx, isFee: true } : tx;
  });
}

/** Whether a route swaps in the Rhea CLMM contract (where a taxed token pays its tax). */
function touchesClmm(route) {
  if (route.dex_id === 'RheaDcl') return true;
  return (route.execution_instructions || []).some((step) =>
    (step?.NearTransaction?.actions || []).some((a) => {
      try {
        return a.FunctionCall?.method_name === 'ft_transfer_call' && decodeArgs(a.FunctionCall.args).receiver_id === CONTRACTS.dcl;
      } catch {
        return false;
      }
    })
  );
}

/**
 * A taxed input reaches the CLMM pools short by its tax, but the aggregator set the route's minimum
 * output for the full input: lower that minimum by the tax, or the swap would always fail.
 */
function widenForTax(transactions, taxInBps) {
  if (!taxInBps) return transactions;
  return transactions.map((tx) => ({
    ...tx,
    actions: tx.actions.map((action) => {
      const { methodName, args } = action.params;
      if (methodName !== 'ft_transfer_call' || args?.receiver_id !== CONTRACTS.dcl) return action;
      const msg = parseMsg(args.msg);
      if (!msg?.Swap?.min_output_amount) return action;
      const swap = { ...msg.Swap, min_output_amount: afterTax(msg.Swap.min_output_amount, taxInBps).toString() };
      return { ...action, params: { ...action.params, args: { ...args, msg: JSON.stringify({ ...msg, Swap: swap }) } } };
    })
  }));
}

/** Intear DEX operations (deposit_near args or an ft_transfer_call msg) must pay the trader back. */
export function checkPlach(payload, user) {
  const list = payload?.operations?.operations ?? payload?.operations;
  if (!Array.isArray(list) || !list.length) throw new Error('Intear DEX route without operations');
  const referrer = payload?.operations?.referrer ?? payload?.referrer;
  if (referrer != null && referrer !== INTEAR_REFERRER) throw new Error(`unexpected referrer "${referrer}"`);
  list.forEach((op) => {
    const [kind] = Object.keys(op || {});
    if (!PLACH_OPERATIONS.has(kind)) throw new Error(`unexpected Intear DEX operation "${kind}"`);
    if (kind === 'Withdraw') {
      const { to, rescue_address: rescue } = op.Withdraw;
      if (to != null && to !== user) throw new Error(`output would be sent to "${to}"`);
      if (rescue != null && rescue !== user) throw new Error(`refunds would go to "${rescue}"`);
    }
  });
}

/** Rhea swap messages: the referral (if any) must be KINU's; outputs always return to the sender. */
function checkRheaMsg(msg) {
  const parsed = parseMsg(msg);
  if (!parsed) throw new Error('unreadable Rhea swap message');
  if (parsed.referral_id != null && parsed.referral_id !== INTEAR_REFERRER) throw new Error(`unexpected referral "${parsed.referral_id}"`);
  if (parsed.receiver_id != null || parsed.Swap?.receiver_id != null) throw new Error('Rhea swap with another receiver');
}

/**
 * Throws unless these transactions only swap `amountIn` of tokenIn for the trader: no other
 * token is spent, no more than the input is attached, and every output comes back to `user`.
 * With KINU's Intear fee on (`feeBps`), fee transfers of the input token are allowed only to
 * KINU's and Intear's fee accounts, at most `feeBps` of the input, counted within the input.
 */
export function assertIntearRoute(transactions, { tokenIn, amountIn, user, feeBps = 0 }) {
  const input = contractOf(tokenIn);
  const limit = toBigInt(amountIn);
  let nearSpent = 0n;
  let tokenSpent = 0n;
  let feeSpent = 0n;
  let feesStarted = false;
  transactions.forEach((tx) => {
    // Fee transactions only pay fees, and only after every swap transaction.
    if (tx.isFee) feesStarted = true;
    else if (feesStarted) throw new Error('swap step after a fee transaction');
    tx.actions.forEach(({ params: { methodName, args = {}, gas, deposit } }) => {
      if (BigInt(gas) > MAX_GAS) throw new Error('gas above the NEAR limit');
      if (tx.isFee && methodName !== 'ft_transfer') throw new Error(`unexpected "${methodName}" in a fee transaction`);
      if (methodName === 'ft_transfer') {
        if (!(feeBps > 0)) throw new Error('route transfers tokens out');
        if (!tx.isFee) throw new Error('fee transfer outside a fee transaction');
        if (tx.receiverId !== input) throw new Error(`fee paid in ${tx.receiverId}`);
        if (!INTEAR_FEE_RECIPIENTS.has(args.receiver_id)) throw new Error(`fee sent to "${args.receiver_id}"`);
        if (BigInt(deposit || '0') !== 1n) throw new Error('unexpected deposit on a fee transfer');
        feeSpent += toBigInt(args.amount);
        return;
      }
      const allowed = METHODS[tx.receiverId] || (tx.receiverId === input ? ['storage_deposit', 'ft_transfer_call'] : ['storage_deposit']);
      if (!allowed.includes(methodName)) throw new Error(`unexpected "${methodName}" on ${tx.receiverId}`);
      if (methodName === 'storage_deposit' && args.account_id != null && args.account_id !== user) {
        throw new Error(`storage for "${args.account_id}"`);
      }
      if (methodName === 'near_deposit' || methodName === 'deposit_near') {
        if (!tokenIn.native) throw new Error('route attaches NEAR to a token swap');
        nearSpent += BigInt(deposit);
      }
      if (methodName === 'deposit_near') checkPlach(args, user);
      if (methodName === 'ft_transfer_call') {
        if (tx.receiverId !== input) throw new Error(`route spends ${tx.receiverId}`);
        if (!DESTINATIONS.has(args.receiver_id)) throw new Error(`tokens sent to "${args.receiver_id}"`);
        tokenSpent += toBigInt(args.amount);
        if (args.receiver_id === CONTRACTS.intearDex) checkPlach(parseMsg(args.msg), user);
        else checkRheaMsg(args.msg);
      }
    });
  });
  if (nearSpent > limit) throw new Error('route attaches more NEAR than the swap amount');
  if (feeSpent * 100_000n > limit * BigInt(Math.round(feeBps * 10)) + 100_000n) throw new Error('route fee above the agreed rate');
  if (tokenSpent + feeSpent > limit) throw new Error('route spends more than the swap amount');
  if (tokenSpent === 0n && nearSpent === 0n) throw new Error('route does not spend the input');
}

/**
 * Intear Aggregator routes for amountIn (raw) of tokenIn -> tokenOut, best first: at most one per
 * DEX, in the shape of the other quotes in lib/swap.js plus `intear` (instructions and costs).
 * Routes that would need a second conversion step, or that fail the checks above, are skipped.
 * `dexes` limits the search (e.g. ['Plach']).
 */
export async function getIntearQuotes({ tokenIn, tokenOut, amountIn, slippage, user, signal, dexes = DEXES }) {
  // Taxed tokens (e.g. KINU) are only taxed on transfers into / out of the Rhea CLMM contract:
  // routes through it are adjusted below, routes elsewhere (Rhea classic, Intear DEX) are tax-free.
  const { inBps, outBps } = await swapTax(contractOf(tokenIn), contractOf(tokenOut));

  const params = new URLSearchParams({
    token_in: assetOf(tokenIn),
    token_out: assetOf(tokenOut),
    amount_in: String(amountIn),
    max_wait_ms: String(MAX_WAIT_MS),
    slippage_type: 'Fixed',
    slippage: String(Number(slippage) / 100),
    dexes: dexes.filter((d) => DEXES.includes(d)).join(','),
    referrer_id: INTEAR_REFERRER
  });
  const feeBps = intearFeeBps(tokenIn, tokenOut);
  if (feeBps > 0) params.set('fees', JSON.stringify({ [INTEAR_REFERRER]: feeBps / 10_000 }));
  if (user) params.set('trader_account_id', user);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort());
  let routes;
  try {
    const response = await fetch(`${ENDPOINTS.intearRouter}/route?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error((await response.text()).slice(0, 200) || `Intear HTTP ${response.status}`);
    routes = await response.json();
  } catch (error) {
    if (error.name === 'AbortError' && !signal?.aborted) throw new Error('Intear Aggregator timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(routes) || !routes.length) throw new Error('No Intear route for this pair.');

  // Routes come best first (costs included). Keep the ones KINU can execute as-is.
  const want = assetOf(tokenOut);
  const quotes = [];
  for (const route of routes) {
    if (route.token_output !== want || route.deadline != null || quotes.some((q) => q.intear.dexId === route.dex_id)) continue;
    try {
      const taxIn = touchesClmm(route) ? inBps : 0;
      const taxOut = touchesClmm(route) ? outBps : 0;
      const txs = widenForTax(toTransactions(route.execution_instructions), taxIn);
      assertIntearRoute(txs, { tokenIn, amountIn, user, feeBps });
      const grossOut = String(route.estimated_amount?.amount_out ?? '0');
      if (toBigInt(grossOut) === 0n) continue;
      const taxed = taxIn || taxOut;
      quotes.push({
        amountIn: String(amountIn),
        // What reaches the wallet: the pool gets the input after its tax, the output loses its own.
        amountOut: taxed ? afterTax(afterTax(grossOut, taxIn), taxOut).toString() : grossOut,
        minAmountOut: afterTax(afterTax(String(route.worst_case_amount?.amount_out ?? '0'), taxIn), taxOut).toString(),
        tax: taxed ? { inBps: taxIn, outBps: taxOut, grossOut, netIn: afterTax(amountIn, taxIn).toString() } : null,
        dexs: [DEX_LABEL[route.dex_id] || route.dex_id],
        routeTokens: [contractOf(tokenIn), contractOf(tokenOut)],
        intear: {
          dexId: route.dex_id,
          instructions: route.execution_instructions,
          gasUsage: String(route.estimated_gas_usage || '0'),
          maxGasCost: String(route.estimated_max_gas_cost || '0'),
          storage: String(route.storage_deposits || '0'),
          taxIn,
          // KINU's fee on this route (bps), already taken out of amountOut by the aggregator.
          feeBps,
          // Extra output from Intear's fee discount for TEAR holders (Intear DEX pools), raw, '0' if none.
          discountOut: String(route.discount?.amount_out ?? '0'),
          // For /route/outcome after the swap (intearOutcome).
          tokenInId: params.get('token_in'),
          tokenOutId: params.get('token_out'),
          feeAmount: String(route.fee_amount ?? '0')
        },
        user: user || null,
        fetchedAt: Date.now()
      });
    } catch {
      // Not executable by KINU: try the next route.
    }
  }
  if (!quotes.length) throw new Error('No Intear route KINU can execute for this pair.');
  return quotes;
}

/** The best Intear Aggregator route (see getIntearQuotes). */
export async function getIntearQuote(params) {
  return (await getIntearQuotes(params))[0];
}

/**
 * The transactions of an Intear quote, checked again for this exact account. Each carries `intear`:
 * what lib/state.jsx execute needs to ask /route/outcome whether the swap went through before it
 * sends the fee transactions (a failed Rhea swap still lets its transaction succeed).
 */
export function buildIntearSwapTransactions({ tokenIn, tokenOut, quote, accountId }) {
  const txs = widenForTax(toTransactions(quote.intear.instructions), quote.intear.taxIn || 0);
  assertIntearRoute(txs, { tokenIn, amountIn: quote.amountIn, user: accountId, feeBps: quote.intear.feeBps || 0 });
  const route = {
    tokenIn: quote.intear.tokenInId || assetOf(tokenIn),
    tokenOut: quote.intear.tokenOutId || (tokenOut ? assetOf(tokenOut) : null),
    feeAmount: quote.intear.feeAmount || '0',
    outSymbol: tokenOut?.symbol || '',
    outDecimals: tokenOut?.decimals
  };
  return route.tokenOut ? txs.map((tx) => ({ ...tx, intear: route })) : txs;
}

const OUTCOME_TIMEOUT_MS = 20_000;

/**
 * What a route's swap transactions did (docs.intear.tech/dex-aggregator/reference/outcome):
 * `charge_fee` (the trader got output), `amount_out`, `error` (written for traders) and
 * `next_steps` (e.g. unwrap wNEAR left by a failed swap from NEAR). Waits for execution.
 */
export async function intearOutcome({ route, trader, hashes }) {
  const params = new URLSearchParams({
    token_in: route.tokenIn,
    token_out: route.tokenOut,
    trader_account_id: trader,
    tx_hashes: hashes.join(','),
    fee_amount: route.feeAmount || '0',
    wait_until: 'executed'
  });
  const response = await fetch(`${ENDPOINTS.intearRouter}/route/outcome?${params}`, { signal: AbortSignal.timeout(OUTCOME_TIMEOUT_MS) });
  if (!response.ok) throw new Error((await response.text()).slice(0, 200) || `Intear outcome HTTP ${response.status}`);
  const outcome = await response.json();
  if (typeof outcome?.charge_fee !== 'boolean') throw new Error('unreadable Intear outcome');
  return outcome;
}

/**
 * An outcome's next steps as KINU transactions. Only unwrapping the trader's own wNEAR is accepted
 * (the one case KINU's routes leave behind); anything else is refused and left to the user.
 */
export function buildIntearNextSteps(outcome) {
  const steps = outcome?.next_steps;
  if (!Array.isArray(steps) || !steps.length) return [];
  const txs = toTransactions(steps);
  txs.forEach((tx) => {
    if (tx.receiverId !== CONTRACTS.wrapNear) throw new Error(`unexpected next step on ${tx.receiverId}`);
    tx.actions.forEach(({ params: { methodName, deposit } }) => {
      if (methodName !== 'near_withdraw') throw new Error(`unexpected next step "${methodName}"`);
      if (BigInt(deposit || '0') !== 1n) throw new Error('unexpected deposit on a next step');
    });
  });
  return txs;
}

/** Network fee of an Intear quote, from the aggregator's own estimate (same shape as estimateNetworkFee). */
export function intearNetworkFee(quote) {
  const toNear = (yocto) => Number(yocto) / 1e24;
  return { feeNear: toNear(quote.intear.gasUsage), maxFeeNear: toNear(quote.intear.maxGasCost), storageNear: toNear(quote.intear.storage) };
}
