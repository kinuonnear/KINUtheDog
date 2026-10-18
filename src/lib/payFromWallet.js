// "Pay from wallet" on the Bridge: instead of copying a deposit address into another app, the user
// sends the quoted amount straight from a browser wallet on the chain the money is on (MetaMask,
// Rabby, Coinbase Wallet … on EVM chains; Phantom, Solflare, Backpack on Solana). The same transfer
// NEAR Intents' own wallet kit (@aurora-is-near/intents-connect-wallet) makes, written here against
// the wallets' standard interfaces so the Bridge doesn't pull in its many wallet SDKs.
//
// What gets sent is fixed by the verified quote the page already holds: exactly `amountIn` of the
// quoted asset to its one-time deposit address. Nothing here picks an address or an amount.

/** EVM chain ids for the 1Click chains a browser wallet can pay from. */
export const EVM_CHAIN_IDS = {
  eth: 1,
  base: 8453,
  arb: 42161,
  bsc: 56,
  op: 10,
  pol: 137,
  avax: 43114,
  gnosis: 100,
  bera: 80094,
  scroll: 534352,
  monad: 143,
  xlayer: 196,
  plasma: 9745,
  abs: 2741
};

const SOLANA_RPC = 'https://solana-rpc.publicnode.com';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Which kind of browser wallet can pay a deposit on `chain`: 'evm', 'sol' or null. */
export function walletKindFor(chain) {
  if (EVM_CHAIN_IDS[chain]) return 'evm';
  if (chain === 'sol') return 'sol';
  return null;
}

/* ---------------------------------------------------------------- EVM (EIP-1193 / EIP-6963) */

const announced = new Map(); // uuid -> { info, provider }
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const { info, provider } = event.detail || {};
    if (info?.uuid && provider?.request) announced.set(info.uuid, { info, provider });
  });
}

/** Browser EVM wallets (each announces itself by EIP-6963; window.ethereum when none do). */
export async function findEvmWallets() {
  if (typeof window === 'undefined') return [];
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 150));
  const list = [...announced.values()].map(({ info, provider }) => ({ id: info.uuid, name: info.name, icon: info.icon, provider }));
  if (!list.length && window.ethereum?.request) list.push({ id: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: null, provider: window.ethereum });
  return list;
}

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const pad32 = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Ask the wallet for its address (connects it). */
export async function evmAddress(provider) {
  const [address] = await provider.request({ method: 'eth_requestAccounts' });
  if (!EVM_ADDRESS.test(String(address))) throw new Error('Your wallet didn’t share an address.');
  return address;
}

async function switchChain(provider, chainId, chainLabel) {
  const current = parseInt(await provider.request({ method: 'eth_chainId' }), 16);
  if (current === chainId) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(chainId) }] });
  } catch (error) {
    if (error?.code === 4902) throw new Error(`Add ${chainLabel} to your wallet first, then try again.`);
    throw new Error(`Switch your wallet to ${chainLabel} to pay.`);
  }
  const now = parseInt(await provider.request({ method: 'eth_chainId' }), 16);
  if (now !== chainId) throw new Error(`Your wallet is still on another network. Switch it to ${chainLabel} and try again.`);
}

/**
 * Send `amount` (smallest units) of `asset` to `to` from an EVM wallet: a plain transfer for the
 * chain's own coin, an ERC-20 `transfer` otherwise. Returns the transaction hash.
 */
export async function payEvm({ provider, chain, chainLabel, asset, to, amount }) {
  const chainId = EVM_CHAIN_IDS[chain];
  if (!chainId) throw new Error(`Paying from a wallet isn’t available on ${chainLabel}.`);
  if (!EVM_ADDRESS.test(to)) throw new Error('Unexpected deposit address. Nothing was sent.');
  if (!(BigInt(amount) > 0n)) throw new Error('Nothing to send.');
  const from = await evmAddress(provider);
  await switchChain(provider, chainId, chainLabel);
  const tx = asset.contractAddress
    ? (() => {
        if (!EVM_ADDRESS.test(asset.contractAddress)) throw new Error('Unexpected token address. Nothing was sent.');
        return { from, to: asset.contractAddress, value: '0x0', data: `0xa9059cbb${pad32(to)}${pad32(hex(amount))}` };
      })()
    : { from, to, value: hex(amount) };
  return provider.request({ method: 'eth_sendTransaction', params: [tx] });
}

/* ---------------------------------------------------------------- Solana */

/** Injected Solana wallets that are present. */
export function findSolanaWallets() {
  if (typeof window === 'undefined') return [];
  const candidates = [
    { id: 'phantom', name: 'Phantom', provider: window.phantom?.solana },
    { id: 'solflare', name: 'Solflare', provider: window.solflare },
    { id: 'backpack', name: 'Backpack', provider: window.backpack?.solana || window.backpack }
  ];
  const list = candidates.filter((w) => w.provider?.connect && w.provider?.signTransaction);
  if (!list.length && window.solana?.connect) list.push({ id: 'solana', name: 'Solana wallet', provider: window.solana });
  return list;
}

async function solanaRpc(method, params) {
  const response = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const json = await response.json().catch(() => ({}));
  if (json.error || !response.ok) throw new Error(json.error?.message || `Solana RPC HTTP ${response.status}`);
  return json.result;
}

/** Connect the wallet; its address (base58). */
export async function solanaAddress(provider) {
  const res = await provider.connect();
  const key = res?.publicKey || provider.publicKey;
  const address = key?.toString?.();
  if (!SOL_ADDRESS.test(String(address))) throw new Error('Your wallet didn’t share an address.');
  return address;
}

/**
 * Send `amount` (smallest units) of `asset` to `to` from a Solana wallet: SOL with a system
 * transfer; an SPL token (classic or Token-2022) with transferChecked into the deposit address's
 * token account, created first if it doesn't exist. Returns the signature.
 */
export async function paySolana({ provider, asset, to, amount }) {
  if (!SOL_ADDRESS.test(to)) throw new Error('Unexpected deposit address. Nothing was sent.');
  if (!(BigInt(amount) > 0n)) throw new Error('Nothing to send.');
  const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = await import('@solana/web3.js');
  const owner = new PublicKey(await solanaAddress(provider));
  const dest = new PublicKey(to);
  const tx = new Transaction();
  if (!asset.contractAddress) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: dest, lamports: BigInt(amount) }));
  } else {
    if (!SOL_ADDRESS.test(asset.contractAddress)) throw new Error('Unexpected token address. Nothing was sent.');
    const mint = new PublicKey(asset.contractAddress);
    const info = await solanaRpc('getAccountInfo', [mint.toBase58(), { encoding: 'base64' }]);
    const programId = info?.value?.owner;
    if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022_PROGRAM) throw new Error('This token’s program isn’t supported for wallet payments. Send it manually instead.');
    const tokenProgram = new PublicKey(programId);
    const ataProgram = new PublicKey(ATA_PROGRAM);
    const ata = (wallet) => PublicKey.findProgramAddressSync([wallet.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ataProgram)[0];
    const source = ata(owner);
    const target = ata(dest);
    // Create the deposit address's token account if needed (no-op when it exists).
    tx.add(
      new TransactionInstruction({
        programId: ataProgram,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: target, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgram, isSigner: false, isWritable: false }
        ],
        data: Uint8Array.from([1])
      })
    );
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked
    new DataView(data.buffer).setBigUint64(1, BigInt(amount), true);
    data[9] = asset.decimals;
    tx.add(
      new TransactionInstruction({
        programId: tokenProgram,
        keys: [
          { pubkey: source, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: target, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: false }
        ],
        data
      })
    );
  }
  const { value } = await solanaRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  tx.recentBlockhash = value.blockhash;
  tx.feePayer = owner;
  if (provider.signAndSendTransaction) {
    const res = await provider.signAndSendTransaction(tx);
    return res?.signature || res;
  }
  const signed = await provider.signTransaction(tx);
  const raw = signed.serialize();
  let b64 = '';
  for (let i = 0; i < raw.length; i += 0x8000) b64 += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  return solanaRpc('sendTransaction', [btoa(b64), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
}
