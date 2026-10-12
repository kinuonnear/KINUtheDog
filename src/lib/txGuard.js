// Last check before anything reaches the wallet: every transaction KINU builds
// must match what the app is supposed to do. A bug, a bad API response or
// injected code that tries to send funds elsewhere is refused here, before the
// user is ever asked to sign.
//
//   - only FunctionCall actions (no NEAR transfers, key changes or deploys)
//   - per contract, only the methods KINU uses
//   - tokens may only be sent (ft_transfer_call) to Rhea's contracts
//   - storage is only ever bought for the signer (or for Rhea's contracts on a new token)
//   - attached NEAR is capped, except when wrapping NEAR (the amount the user typed)

import { CONTRACTS } from '../config.js';

const ONE_NEAR = 10n ** 24n;
const MAX_FEE_DEPOSIT = 2n * ONE_NEAR; // storage / registration costs stay far below this

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
  [CONTRACTS.dcl]: ['storage_deposit', 'add_liquidity', 'batch_add_liquidity', 'remove_liquidity', 'batch_remove_liquidity', 'withdraw_asset', 'create_pool'],
  [CONTRACTS.aggregator]: ['tokens_storage_deposit', 'withdraw'],
  [CONTRACTS.wrapNear]: ['near_deposit', 'near_withdraw', 'storage_deposit', 'ft_transfer_call']
};

/** Any other receiver is a token contract: register the user, or send tokens into Rhea. */
const TOKEN_METHODS = ['storage_deposit', 'ft_transfer_call'];

/** Where tokens may be sent with ft_transfer_call. */
const TOKEN_DESTINATIONS = new Set([CONTRACTS.exchange, CONTRACTS.dcl, CONTRACTS.aggregator]);

function refuse(tx, reason) {
  throw new Error(`Blocked for your safety: ${reason} (${tx.receiverId}). Nothing was sent to your wallet.`);
}

/** Throws if any transaction falls outside what KINU is allowed to ask the wallet to sign. */
export function assertSafeTransactions(transactions, signerId) {
  if (!signerId) throw new Error('No connected account.');
  transactions.forEach((tx) => {
    if (!tx || typeof tx.receiverId !== 'string' || !Array.isArray(tx.actions) || !tx.actions.length) {
      refuse(tx || { receiverId: '?' }, 'malformed transaction');
    }
    const allowed = PROTOCOL_METHODS[tx.receiverId] || TOKEN_METHODS;
    tx.actions.forEach((action) => {
      if (action?.type !== 'FunctionCall') refuse(tx, `"${action?.type}" actions are never used by KINU`);
      const { methodName, args = {}, deposit = '0' } = action.params || {};
      if (!allowed.includes(methodName)) refuse(tx, `unexpected method "${methodName}"`);

      const attached = BigInt(deposit || '0');
      const isWrap = tx.receiverId === CONTRACTS.wrapNear && methodName === 'near_deposit';
      if (!isWrap && attached > MAX_FEE_DEPOSIT) refuse(tx, `"${methodName}" attaches an unusually large NEAR deposit`);

      if (methodName === 'ft_transfer_call' && !TOKEN_DESTINATIONS.has(args.receiver_id)) {
        refuse(tx, `tokens would be sent to "${args.receiver_id}", which is not a Rhea contract`);
      }
      // Storage is bought for the signer — or, when a token is new to Rhea, for Rhea's own
      // contracts so they can hold it (needed before a pool with that token can be used).
      if (methodName === 'storage_deposit' && args.account_id && args.account_id !== signerId && !TOKEN_DESTINATIONS.has(args.account_id)) {
        refuse(tx, `storage would be bought for "${args.account_id}" instead of you`);
      }
      if (methodName === 'tokens_storage_deposit' && args.user !== signerId) {
        refuse(tx, `router storage would be bought for "${args.user}" instead of you`);
      }
    });
  });
}
