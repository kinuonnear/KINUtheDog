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
  // Contract used as the wallet sign-in target
  signIn: 'kinu.nearlytrade.near'
};

export const ENDPOINTS = {
  // Ordered by preference; the RPC client fails over automatically.
  rpc: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
  rheaApi: 'https://api.rhea.finance',
  rheaIndexer: 'https://indexer.ref.finance',
  smartRouter: 'https://smartx.rhea.finance',
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
  aggregatorSwap: '600000000000000',
  aggregatorTokenStorage: '30000000000000',
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
export const NEAR_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2216%22%20r%3D%2216%22%20fill%3D%22%230b0f0c%22%2F%3E%3Cpath%20d%3D%22M10%2023V9h2.2l7.6%2010.2V9H22v14h-2.2l-7.6-10.2V23z%22%20fill%3D%22%23b8ff3d%22%2F%3E%3C%2Fsvg%3E';

export const NATIVE_NEAR = {
  id: 'near',
  contract: CONTRACTS.wrapNear,
  symbol: 'NEAR',
  name: 'NEAR',
  decimals: 24,
  icon: NEAR_ICON,
  native: true
};

// Tokens pinned at the top of the token picker.
export const PINNED_TOKENS = [
  'near',
  'kinu.nearlytrade.near',
  'token.rhealab.near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'usdt.tether-token.near',
  'ninu-4.nearlytrade.near',
  'wrap.near'
];
