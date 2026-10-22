// Last check before anything reaches the wallet: every transaction KINU builds
// must match what the app is supposed to do. A bug, a bad API response or
// injected code that tries to send funds elsewhere is refused here, before the
// user is ever asked to sign.
//
//   - only FunctionCall actions (no NEAR transfers, key changes or deploys)
//   - per contract, only the methods KINU uses
//   - tokens may only be sent (ft_transfer_call) to Rhea's contracts or Intear DEX (aggregator routes)
//   - storage is only ever bought for the signer (or for Rhea's contracts on a new token, or for
//     KINU's public treasury so it can receive the platform fee)
//   - attached NEAR is capped, except when wrapping NEAR, depositing it into Intear DEX or staking
//     it with LiNEAR / Meta Pool (the amount the user typed; Intear routes are also checked in
//     lib/intearRouter.js)
//   - tokens may be sent (ft_transfer) and storage bought only for a NEAR Intents deposit address
//     that a withdrawal just got from a 1Click quote whose signature verified (allowBridgeDeposit),
//     and only that quote's token and amount
//   - the message of every transfer into a DEX must pay the output to the signer: Rhea routes,
//     CLMM / exchange swaps and Intear DEX operations (lib/routeMsg.js, lib/intearRouter.js)
//   - on NEAR Intents' Verifier (intents.near) only registering the key the user just signed an Earn
//     withdrawal with (allowIntentsKey), so the Verifier accepts that signature, and withdrawing a
//     token from the signer's own Intents balance to the signer's own wallet

import { CONTRACTS, INTEAR_FEE, PLATFORM_FEE, QUICK_LP_FEE } from '../config.js';
import { checkPlach, INTEAR_FEE_RECIPIENTS } from './intearRouter.js';
import { checkRheaTransferMsg } from './routeMsg.js';

const ONE_NEAR = 10n ** 24n;
const MAX_FEE_DEPOSIT = 2n * ONE_NEAR; // storage / registration costs stay far below this
// A token's storage_deposit normally costs 0.00125 NEAR; the cost comes from the token
// contract itself, so a hostile token could ask for more — and keep it.
const MAX_TOKEN_STORAGE = ONE_NEAR / 20n; // 0.05 NEAR
// All fees in one signing request together (wrapping NEAR excluded).
const MAX_BUNDLE_FEES = 2n * ONE_NEAR;

/** Contracts KINU talks to directly, and the methods it calls on each. */
const PROTOCOL_METHODS = {
  [CONTRACTS.exchange]: [
    'storage_deposit',
    'register_tokens',
    'add_liquidity',
    'add_stable_liquidity',
    'remove_liquidity',
    'withdraw',
    'claim_lostfound',
    'add_simple_pool'
  ],
  [CONTRACTS.dcl]: ['storage_deposit', 'add_liquidity', 'batch_add_liquidity', 'remove_liquidity', 'batch_remove_liquidity', 'append_liquidity', 'withdraw_asset', 'create_pool'],
  [CONTRACTS.aggregator]: ['tokens_storage_deposit', 'withdraw'],
  [CONTRACTS.wrapNear]: ['near_deposit', 'near_withdraw', 'storage_deposit', 'ft_transfer_call'],
  // Intear DEX, reached through the Intear DEX Aggregator's swap routes
  [CONTRACTS.intearDex]: ['deposit_near', 'register_assets', 'storage_deposit'],
  // Liquid staking (lib/staking.js); both are also tokens, so their token methods stay allowed.
  'linear-protocol.near': ['deposit_and_stake', 'unstake', 'unstake_all', 'withdraw_all', ...['storage_deposit', 'ft_transfer_call']],
  'meta-pool.near': ['deposit_and_stake', 'unstake', 'unstake_all', 'withdraw_unstaked', 'liquid_unstake', ...['storage_deposit', 'ft_transfer_call']]
};

/** Staking contracts: `deposit_and_stake` attaches the NEAR the user chose to stake. */
const STAKING_CONTRACTS = new Set(['linear-protocol.near', 'meta-pool.near']);

/** Any other receiver is a token contract: register the user, or send tokens into Rhea. */
const TOKEN_METHODS = ['storage_deposit', 'ft_transfer_call'];

/** Where tokens may be sent with ft_transfer_call. */
const TOKEN_DESTINATIONS = new Set([CONTRACTS.exchange, CONTRACTS.dcl, CONTRACTS.aggregator, CONTRACTS.intearDex]);

// Deposit addresses of verified 1Click withdrawal quotes (lib/intents.js), each for 30 minutes.
const BRIDGE_TTL_MS = 30 * 60_000;
// One registry for the whole page, even if this module is loaded twice (as the dev server can).
const bridgeDeposits = (globalThis.__kinuBridgeDeposits ||= new Map());

/**
 * Lets one verified NEAR Intents deposit address (a 64-hex implicit account) receive one
 * withdrawal: exactly `amount` (raw) of `token`, the quote's own figures.
 */
export function allowBridgeDeposit(address, token, amount) {
  if (!/^[0-9a-f]{64}$/.test(String(address))) throw new Error('Unexpected deposit address for a withdrawal.');
  if (!token || !/^\d+$/.test(String(amount))) throw new Error('Unexpected withdrawal amount.');
  bridgeDeposits.set(address, { until: Date.now() + BRIDGE_TTL_MS, token, amount: String(amount) });
}

// Keys the user just signed an Earn withdrawal with (lib/earn.js), each for 10 minutes.
const INTENTS_CONTRACT = 'intents.near';
const INTENTS_KEY_TTL_MS = 10 * 60_000;
const intentsKeys = (globalThis.__kinuIntentsKeys ||= new Map());

/** Lets one public key (the one the wallet just signed with) be registered on intents.near. */
export function allowIntentsKey(publicKey) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(String(publicKey))) throw new Error('Unexpected public key.');
  intentsKeys.set(publicKey, Date.now() + INTENTS_KEY_TTL_MS);
}

const bridgeDeposit = (address) => {
  const entry = bridgeDeposits.get(address);
  return entry && entry.until > Date.now() ? entry : null;
};
const isBridgeDeposit = (address) => Boolean(bridgeDeposit(address));

function parseMsg(msg) {
  try {
    return JSON.parse(msg);
  } catch {
    return null;
  }
}

function refuse(tx, reason) {
  throw new Error(`Blocked for your safety: ${reason} (${tx.receiverId}). Nothing was sent to your wallet.`);
}

/** Throws if any transaction falls outside what KINU is allowed to ask the wallet to sign. */
export function assertSafeTransactions(transactions, signerId) {
  if (!signerId) throw new Error('No connected account.');
  let fees = 0n;
  transactions.forEach((tx) => {
    if (!tx || typeof tx.receiverId !== 'string' || !Array.isArray(tx.actions) || !tx.actions.length) {
      refuse(tx || { receiverId: '?' }, 'malformed transaction');
    }
    const allowed = PROTOCOL_METHODS[tx.receiverId] || TOKEN_METHODS;
    tx.actions.forEach((action) => {
      if (action?.type !== 'FunctionCall') refuse(tx, `"${action?.type}" actions are never used by KINU`);
      const { methodName, args = {}, deposit = '0' } = action.params || {};
      if (tx.receiverId === INTENTS_CONTRACT) {
        const keyOk = methodName === 'add_public_key' && intentsKeys.get(args.public_key) > Date.now();
        const withdrawOk = methodName === 'ft_withdraw' && args.receiver_id === signerId && !('msg' in args);
        if (!keyOk && !withdrawOk) refuse(tx, `unexpected method "${methodName}"`);
        if (BigInt(deposit || '0') !== 1n) refuse(tx, 'unexpected deposit on NEAR Intents');
        return;
      }
      if (methodName === 'ft_transfer' && isBridgeDeposit(args.receiver_id)) {
        // A withdrawal to other chains: to the verified 1Click deposit address only, and only the
        // token and amount of that quote.
        const quote = bridgeDeposit(args.receiver_id);
        if (tx.receiverId !== quote.token || String(args.amount) !== quote.amount) refuse(tx, 'this withdrawal differs from its verified quote');
        if (BigInt(deposit || '0') !== 1n) refuse(tx, 'unexpected deposit on a withdrawal transfer');
        return;
      }
      if (methodName === 'ft_transfer') {
        // Only KINU's fees: the platform fee to the treasury, or (once live) an Intear route's fee to
        // KINU's and Intear's fee accounts. Their size is checked over the whole bundle below.
        const platformFee = PLATFORM_FEE.enabled && args.receiver_id === PLATFORM_FEE.treasury;
        const intearFee = INTEAR_FEE.live && INTEAR_FEE_RECIPIENTS.has(args.receiver_id);
        if (!platformFee && !intearFee) {
          refuse(tx, `tokens would be sent to "${args.receiver_id}"`);
        }
        if (BigInt(deposit || '0') !== 1n) refuse(tx, 'unexpected deposit on a fee transfer');
        return;
      }
      if (!allowed.includes(methodName)) refuse(tx, `unexpected method "${methodName}"`);

      const attached = BigInt(deposit || '0');
      const isWrap =
        (tx.receiverId === CONTRACTS.wrapNear && methodName === 'near_deposit') ||
        (tx.receiverId === CONTRACTS.intearDex && methodName === 'deposit_near') ||
        (STAKING_CONTRACTS.has(tx.receiverId) && methodName === 'deposit_and_stake');
      // Nothing but staking itself carries NEAR into a staking contract.
      if (STAKING_CONTRACTS.has(tx.receiverId) && methodName !== 'deposit_and_stake' && methodName !== 'storage_deposit' && attached > 1n) {
        refuse(tx, `"${methodName}" should not attach NEAR`);
      }
      if (!isWrap && attached > MAX_FEE_DEPOSIT) refuse(tx, `"${methodName}" attaches an unusually large NEAR deposit`);
      if (!isWrap) fees += attached;
      if (fees > MAX_BUNDLE_FEES) refuse(tx, 'the fees in this request add up to an unusually large NEAR amount');
      if (!PROTOCOL_METHODS[tx.receiverId] && methodName === 'storage_deposit' && attached > MAX_TOKEN_STORAGE) {
        refuse(tx, 'this token asks for an unusually large registration fee');
      }

      if (methodName === 'ft_transfer_call' && !TOKEN_DESTINATIONS.has(args.receiver_id)) {
        refuse(tx, `tokens would be sent to "${args.receiver_id}", which is not a Rhea or Intear DEX contract`);
      }
      // What the DEX is asked to do with the tokens: the output must come back to the signer.
      try {
        if (methodName === 'ft_transfer_call' && args.receiver_id === CONTRACTS.intearDex) checkPlach(parseMsg(args.msg), signerId);
        else if (methodName === 'ft_transfer_call') checkRheaTransferMsg(args.receiver_id, args.msg, signerId, CONTRACTS.aggregator);
        if (tx.receiverId === CONTRACTS.intearDex && methodName === 'deposit_near') checkPlach(args, signerId);
      } catch (error) {
        refuse(tx, error.message);
      }
      // Storage is bought for the signer — or, when a token is new to Rhea, for Rhea's own
      // contracts so they can hold it (needed before a pool with that token can be used).
      if (
        methodName === 'storage_deposit' &&
        args.account_id &&
        args.account_id !== signerId &&
        !TOKEN_DESTINATIONS.has(args.account_id) &&
        !isBridgeDeposit(args.account_id) &&
        args.account_id !== PLATFORM_FEE.treasury
      ) {
        refuse(tx, `storage would be bought for "${args.account_id}" instead of you`);
      }
      if (methodName === 'tokens_storage_deposit' && args.user !== signerId) {
        refuse(tx, `router storage would be bought for "${args.user}" instead of you`);
      }
    });
  });
  assertFeeWithinRate(transactions);
}

/**
 * A platform fee in a token may be at most `bps` of what is spent in that token in the same
 * request (fee + the amounts sent into Rhea), so a bug can never send more than the fee.
 */
// The highest fee rate any one swap may carry (platform fee, or an Intear route's fee).
const MAX_FEE_BPS = Math.max(PLATFORM_FEE.enabled ? PLATFORM_FEE.bps : 0, INTEAR_FEE.live ? INTEAR_FEE.bps : 0);

// A request that opens a CLMM position may also carry Quick LP's fee (QUICK_LP_FEE), on top of the
// swap fee a Zap pays on its swapped part.
const LP_METHODS = new Set(['add_liquidity', 'batch_add_liquidity', 'append_liquidity']);

function assertFeeWithinRate(transactions) {
  const opensPosition = transactions.some(
    (tx) => tx.receiverId === CONTRACTS.dcl && tx.actions.some(({ params: { methodName } = {} }) => LP_METHODS.has(methodName))
  );
  const maxBps = MAX_FEE_BPS + (opensPosition && QUICK_LP_FEE.enabled ? QUICK_LP_FEE.bps : 0);
  const fee = new Map();
  const spent = new Map();
  const add = (map, token, amount) => map.set(token, (map.get(token) || 0n) + BigInt(amount || '0'));
  transactions.forEach((tx) =>
    tx.actions.forEach(({ params: { methodName, args = {} } = {} }) => {
      if (methodName === 'ft_transfer' && !isBridgeDeposit(args.receiver_id)) add(fee, tx.receiverId, args.amount);
      if (methodName === 'ft_transfer_call') add(spent, tx.receiverId, args.amount);
    })
  );
  fee.forEach((amount, token) => {
    const gross = amount + (spent.get(token) || 0n);
    if (!spent.get(token) || amount * 100_000n > gross * BigInt(Math.round(maxBps * 10)) + 100_000n) {
      refuse({ receiverId: token }, 'the platform fee is larger than the published rate');
    }
  });
}
