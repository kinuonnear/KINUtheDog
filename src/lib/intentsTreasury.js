// The treasury's NEAR Intents balance (/treasury): Bridge and Earn fees (1Click `appFees`) are paid
// into kinu-treasury.near's balance inside intents.near, in whatever token the user sent (USDC,
// wNEAR, bridged SOL, vault shares…). From there the treasury can withdraw NEAR tokens to its wallet
// (intents.near ft_withdraw, to itself only) or convert anything else to USDC on NEAR through a 1Click
// quote paid from that balance with a signed message (lib/earn.js payFromIntents).

import { assertQuoteMatches, postQuote } from './intents.js';
import { verifyQuoteSignature } from './intentsSignature.js';
import { getAssetInfo, payFromIntents, PAY } from './earn.js';
import { ensureStorageTx, functionCall, transaction } from './tx.js';
import { view } from './rpc.js';

const INTENTS = 'intents.near';
const GAS_WITHDRAW = '100000000000000'; // 100 TGas, as NEAR Intents' docs ask

/** Every token the account holds inside NEAR Intents, with 1Click's symbol, decimals and USD value, largest first. */
export async function getIntentsHoldings(accountId) {
  const owned = await view(INTENTS, 'mt_tokens_for_owner', { account_id: accountId }, { fresh: true });
  const ids = (owned || []).map((t) => t.token_id).filter(Boolean);
  if (!ids.length) return [];
  const [balances, info] = await Promise.all([view(INTENTS, 'mt_batch_balance_of', { account_id: accountId, token_ids: ids }, { fresh: true }), getAssetInfo()]);
  return ids
    .map((id, i) => {
      const t = info.get(id) || {};
      const amount = BigInt(balances?.[i] || '0');
      const decimals = Number.isInteger(t.decimals) ? t.decimals : 0;
      return {
        assetId: id,
        symbol: t.symbol || id.replace(/^nep\d+:/, '').slice(0, 12),
        decimals,
        chain: t.blockchain || null,
        amount,
        usd: decimals ? (Number(amount) / 10 ** decimals) * (Number(t.price) || 0) : 0,
        // A NEAR token comes out to the wallet as is; anything bridged is converted to USDC instead.
        onNear: t.blockchain === 'near' && /^nep141:/.test(id)
      };
    })
    .filter((h) => h.amount > 0n)
    .sort((a, b) => b.usd - a.usd);
}

/** Withdraw a NEAR token from the account's Intents balance to its own wallet. */
export async function withdrawToWalletTxs({ assetId, amount, accountId }) {
  const token = assetId.replace(/^nep141:/, '');
  return [
    await ensureStorageTx(token, accountId),
    transaction(INTENTS, [functionCall('ft_withdraw', { token, receiver_id: accountId, amount: String(amount) }, GAS_WITHDRAW, '1')])
  ].filter(Boolean);
}

/** A 1Click quote converting `amount` of a token in the account's Intents balance to USDC in its NEAR wallet. */
export async function convertQuote({ assetId, amount, accountId, dry = true }) {
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: assetId,
    depositType: 'INTENTS',
    destinationAsset: PAY.usdc.assetId,
    amount: String(amount),
    recipient: accountId,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: accountId,
    refundType: 'INTENTS',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: 'kinu'
  };
  const json = await postQuote(body);
  assertQuoteMatches(body, json);
  const verified = verifyQuoteSignature(json);
  if (!dry && (!verified || !/^[0-9a-f]{64}$/.test(String(json.quote?.depositAddress)))) throw new Error("This quote couldn't be verified as coming from NEAR Intents. Nothing was signed.");
  return { ...json.quote, request: json.quoteRequest, verified };
}

/** Convert a holding to USDC: a fresh signed quote, paid from the Intents balance with a signed message. */
export async function convertToUsdc({ assetId, amount, accountId, registerKey }) {
  const quote = await convertQuote({ assetId, amount, accountId, dry: false });
  return payFromIntents({ quote, accountId, registerKey });
}
