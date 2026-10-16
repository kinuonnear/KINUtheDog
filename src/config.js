// Central configuration: contracts, endpoints and protocol constants.
// Every on-chain/off-chain data source used by the app is declared here.

export const NETWORK_ID = 'mainnet';

export const CONTRACTS = {
  // Rhea (formerly Ref Finance) classic AMM / stable / rated pools
  exchange: 'v2.ref-finance.near',
  // Rhea concentrated liquidity (DCL / CLMM)
  dcl: 'dclv2.ref-labs.near',
  // Rhea boost farm (staked LP shares)
  boostFarm: 'boostfarm.ref-labs.near',
  // Rhea swap aggregator used by app.rhea.finance (multi-dex routes)
  aggregator: 'aggregatedex.near',
  wrapNear: 'wrap.near',
  // Intear DEX (Plach): swaps routed through the Intear DEX Aggregator may land here
  intearDex: 'dex.intear.near',
  // Contract used as the wallet sign-in target
  signIn: 'kinu-3.nearlytrade.near'
};

export const ENDPOINTS = {
  // KINU's own reads, ordered by preference; the RPC client fails over automatically.
  // (rpc.mainnet.near.org is shut down and refuses every request.)
  // (The public dRPC endpoint rate-limits quickly, so more community endpoints share the load.)
  rpc: ['https://near.drpc.org', 'https://rpc.intea.rs', 'https://nearinner.deltarpc.com', 'https://rpc.shitzuapes.xyz'],
  // Tried only after every endpoint above failed, and only for reads the visitor just asked for
  // (lib/rpc.js). Wallets such as Meteor broadcast through FastNEAR, rate-limited per IP: KINU's
  // background refreshes stay off it so they don't use up the quota a wallet needs.
  rpcReserve: ['https://free.rpc.fastnear.com'],
  // For the wallets (wallet-selector + their modules). Some modules only use the FIRST url, so it
  // differs from the app's own: KINU's live reads can't use up the quota a wallet call needs.
  // (rpc.intea.rs is last: it slows requests down without an API key.)
  walletRpc: ['https://near.drpc.org', 'https://free.rpc.fastnear.com', 'https://rpc.intea.rs'],
  rheaApi: 'https://api.rhea.finance',
  rheaIndexer: 'https://indexer.ref.finance',
  smartRouter: 'https://smartx.rhea.finance',
  // Intear DEX Aggregator (docs.intear.tech/dex-aggregator): routes over Rhea, Rhea CLMM and Plach
  intearRouter: 'https://router.intear.tech',
  fastnear: 'https://api.fastnear.com',
  dexscreener: 'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com/api/v2',
  explorer: 'https://nearblocks.io',
  rheaApp: 'https://app.rhea.finance'
};

export const GAS = {
  storageDeposit: '50000000000000',
  nearDeposit: '50000000000000',
  ftTransferCall: '180000000000000',
  // Depositing into the CLMM contract (ft_transfer_call msg "Deposit") burns ~260-410 TGas on
  // mainnet; 180 TGas always ran out and 400 TGas often did. Unused gas is refunded.
  dclDeposit: '600000000000000',
  aggregatorSwap: '600000000000000',
  aggregatorTokenStorage: '30000000000000',
  aggregatorWithdraw: '300000000000000', // same as app.rhea.finance (withdraw + callbacks)
  registerTokens: '30000000000000',
  addLiquidity: '150000000000000',
  removeLiquidity: '30000000000000',
  withdraw: '55000000000000'
};

export const DEPOSIT = {
  oneYocto: '1',
  // Fallback NEP-145 registration cost if storage_balance_bounds is unavailable.
  ftStorageFallback: '1250000000000000000000', // 0.00125 NEAR
  // Rhea exchange account storage
  exchangeRegister: '100000000000000000000000', // 0.1 NEAR
  exchangeTopUp: '10000000000000000000000', // 0.01 NEAR
  exchangeMinFree: '5000000000000000000000', // 0.005 NEAR
  // Storage for LP shares on add_liquidity
  lpStorage: '10000000000000000000000', // 0.01 NEAR
  // Per-token storage in the aggregator contract
  aggregatorTokenStorage: '5000000000000000000000' // 0.005 NEAR
};

// Keep this much NEAR untouched when the user presses MAX on native NEAR.
export const NEAR_GAS_RESERVE = '250000000000000000000000'; // 0.25 NEAR

export const DEFAULT_SLIPPAGE = 0.5; // percent

// Native NEAR is represented as its own pseudo-token; on-chain it is wrap.near.
// Same assets Rhea Finance uses: the official NEAR logo for NEAR, a distinct mark for wNEAR.
export const NEAR_ICON = '/tokens/near-logo.png';
export const WNEAR_ICON = '/tokens/wnear.png';

export const NATIVE_NEAR = {
  id: 'near',
  contract: CONTRACTS.wrapNear,
  symbol: 'NEAR',
  name: 'NEAR',
  decimals: 24,
  icon: NEAR_ICON,
  native: true
};

// The official $KINU (relaunched 2026-10-12, paired with RHEA). kinu / kinu-2 are not official.
export const KINU_TOKEN = 'kinu-3.nearlytrade.near';

// Platform fee on swaps (whitepaper section 6). OFF until it is announced: set enabled to true
// only after the docs, security page and an announcement say so. bps: 10 = 0.1%.
export const PLATFORM_FEE = { enabled: false, bps: 10, treasury: 'kinu-treasury.near' };

// Account KINU passes as `referrer_id` to the Intear DEX Aggregator. Swaps are tracked under it;
// the referral fee is 0% (Intear's fee setting isn't available yet), so users pay nothing extra.
export const INTEAR_REFERRER = 'kinuonnear.near';

// Tokens KINU has checked by hand (official project tokens) and treats as verified, next to
// Rhea's own whitelist: no "isn't on Rhea's verified list" warning, and a ✓ in the token picker.
export const KINU_VERIFIED_TOKENS = [KINU_TOKEN, 'token.intear.near'];

// Tokens pinned at the top of the token picker.
export const PINNED_TOKENS = [
  'near',
  'kinu-3.nearlytrade.near',
  'token.rhealab.near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'usdt.tether-token.near',
  'wrap.near'
];
