// Readable on-chain failures.
//
// A NEAR transaction can be "successful" while one of its receipts failed — e.g. a token
// deposit whose ft_on_transfer runs out of gas: the token contract refunds the tokens and
// the transaction itself reports success. Wallets differ in how they surface this (Meteor
// shows "publishing_transaction_failed_receipt_execution_outcome"), so KINU checks every
// receipt and, when a wallet only reports a generic error, reads the latest transaction.

const FASTNEAR = 'https://tx.main.fastnear.com/v0';

const CONTRACT_NAMES = {
  'dclv2.ref-labs.near': 'Rhea CLMM',
  'v2.ref-finance.near': 'Rhea exchange',
  'aggregatedex.near': 'Rhea swap router',
  'wrap.near': 'wNEAR'
};

/** First failed status in a wallet outcome (the transaction or any of its receipts). */
export function failureOf(outcome) {
  if (outcome?.status?.Failure) return { failure: outcome.status.Failure, receiver: outcome.transaction?.receiver_id };
  for (const r of outcome?.receipts_outcome || []) {
    if (r.outcome?.status?.Failure) return { failure: r.outcome.status.Failure, receiver: r.outcome.executor_id };
  }
  return null;
}

function executionError(failure) {
  const text = JSON.stringify(failure || {});
  const m = text.match(/"ExecutionError":"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/^Smart contract panicked: /, '') : text.slice(0, 200);
}

/** Human explanation of a failed step. `step` describes what was happening. */
export function describeFailure({ failure, receiver }, step) {
  const error = executionError(failure);
  const where = step || (CONTRACT_NAMES[receiver] ? `A step on ${CONTRACT_NAMES[receiver]}` : 'One step');
  if (/Exceeded the prepaid gas/i.test(error)) {
    return `${where} ran out of gas. Any tokens it was moving were returned to your wallet — nothing is lost. Please try again.`;
  }
  if (/E405/.test(error)) return `${where} failed: this pool already exists.`;
  if (/slippage|E\d{2,3}: .*(min|amount)/i.test(error)) {
    return `${where} failed: the price moved beyond your slippage tolerance (${error}). Tokens not used stay in your wallet or in Rhea deposits.`;
  }
  return `${where} failed: ${error}`;
}

/** What a failed receipt was doing, e.g. "Depositing QTC into Rhea CLMM". */
function stepFromTx(tx, failedReceipt) {
  const t = tx.transaction;
  const call = t.actions?.[0]?.FunctionCall;
  let args = {};
  try {
    args = JSON.parse(atob(call?.args || ''));
  } catch {
    // no JSON args
  }
  if (call?.method_name === 'ft_transfer_call') {
    const token = t.receiver_id.split('.')[0].toUpperCase().slice(0, 12);
    const target = CONTRACT_NAMES[args.receiver_id] || args.receiver_id;
    const kind = /Deposit/.test(args.msg || '') ? 'Depositing' : 'Sending';
    return `${kind} ${token} into ${target}`;
  }
  const where = CONTRACT_NAMES[failedReceipt?.receipt?.receiver_id] || failedReceipt?.receipt?.receiver_id || t.receiver_id;
  return call ? `${call.method_name} on ${where}` : `A step on ${where}`;
}

/**
 * When a wallet only reports a generic failure, find the account's latest failed receipt
 * (signed in the last few minutes) and explain it. Resolves to a message or null.
 */
export async function explainRecentFailure(accountId, withinMs = 5 * 60_000) {
  try {
    const post = (path, body) =>
      fetch(`${FASTNEAR}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const list = await post('/account', { account_id: accountId });
    const recent = (list.account_txs || [])
      .filter((t) => t.is_signer && Date.now() - Number(t.tx_block_timestamp) / 1e6 < withinMs)
      .slice(0, 10);
    if (!recent.length) return null;
    const { transactions = [] } = await post('/transactions', { tx_hashes: recent.map((t) => t.transaction_hash) });
    for (const tx of transactions) {
      const failed = (tx.receipts || []).find((r) => r.execution_outcome?.outcome?.status?.Failure);
      if (failed) {
        return describeFailure(
          { failure: failed.execution_outcome.outcome.status.Failure, receiver: failed.receipt?.receiver_id },
          stepFromTx(tx, failed)
        );
      }
    }
  } catch {
    // explanation is best-effort
  }
  return null;
}

/** Generic "a receipt failed" messages some wallets show instead of the reason. */
export const GENERIC_RECEIPT_FAILURE = /receipt_execution_outcome|publishing_transaction_failed|transaction failed/i;
