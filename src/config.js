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

// Platform fee on swaps (whitepaper section 6), ON since 2026-10-18. bps: 10 = 0.1%. The landing,
// Security, Docs/Terms and whitepaper copy follow this switch (SWAP_FEE_LIVE / FEE_SUMMARY).
export const PLATFORM_FEE = { enabled: true, bps: 10, treasury: 'kinu-treasury.near' };

// Quick LP's convenience fee (the one-tap panel, also opened by the Telegram bot), decided by the
// user 2026-10-22: bps of what goes into a new position, at most maxUsd per position, paid to the
// same treasury after the position is opened. Closing, claiming and the pool page's form are free;
// $KINU and tokens the treasury isn't registered on pay nothing (as the swap fee).
export const QUICK_LP_FEE = { enabled: true, bps: 20, maxUsd: 1 };

// Tokens the treasury is registered on so it can receive the platform fee (a fee in any other
// token is skipped). Registered from the Treasury page by KINU's own accounts. $KINU swaps pay no
// fee, so it is not listed.
export const PLATFORM_FEE_TOKENS = [
  { id: 'wrap.near', symbol: 'wNEAR' },
  { id: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC' },
  { id: 'usdt.tether-token.near', symbol: 'USDT' },
  { id: 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', symbol: 'USDC.e' },
  { id: 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near', symbol: 'USDT.e' },
  { id: 'token.rhealab.near', symbol: 'RHEA' },
  { id: '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', symbol: 'WBTC' },
  { id: 'token.intear.near', symbol: 'INTEAR' },
  { id: 'blackdragon.tkn.near', symbol: 'BLACKDRAGON' },
  { id: 'token.sweat', symbol: 'SWEAT' },
  { id: 'linear-protocol.near', symbol: 'LiNEAR' },
  { id: 'meta-pool.near', symbol: 'stNEAR' },
  { id: 'qtc.omft.near', symbol: 'QTC' },
  { id: 'zec.omft.near', symbol: 'ZEC' },
  { id: 'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near', symbol: 'AURORA' },
  // Nearly tokens can tax transfers, so the treasury may receive slightly less than the fee.
  { id: 'nearly-993927.nearlytrade.near', symbol: 'NEARLY' },
  { id: 'batman-4.nearlytrade.near', symbol: 'BATMAN' }
];

// Account KINU passes as `referrer_id` to the Intear DEX Aggregator: swaps are tracked under it and
// its referral fee (INTEAR_FEE) is paid to it.
export const INTEAR_REFERRER = 'kinu-treasury.near';

// KINU's fee on Intear Aggregator routes, asked per quote (`fees`). Intear pays 80% of it to
// INTEAR_REFERRER and keeps 20%: at 12.5 bps the user pays 0.125% and KINU nets 0.1%, the same as the
// platform fee on other routes (a swap never pays both). Quotes already have it taken out. `live`
// brings Intear routes back to Swap and turns on its disclosure across the app.
export const INTEAR_FEE = { live: true, bps: 12.5, stableBps: 12.5 };

// KINU Holder (lib/holder.js): wallets holding $KINU at the live price get a tier's share off KINU's
// own fees (swap platform fee, Intear route fee, Quick LP fee); Rhea's pool fees are not KINU's.
// The Wallet Tracker stays free and public for everyone. Once a wallet reaches a tier, a price drop
// of up to `grace` keeps it as long as it hasn't sold. `enabled` turns the feature on (badge,
// Portfolio card); `perks` switch the benefits on.
// Discount tiers (user, 2026-10-22, after Intear's TEAR tiers): [$ of KINU held, share off KINU's fees].
// minUsd is the lowest bar (the badge). Pool Analysis stays open to everyone (poolAnalysis off).
export const HOLDER = {
  enabled: true,
  minUsd: 10,
  tiers: [
    [10, 0.1],
    [20, 0.25],
    [100, 0.5],
    [500, 0.75]
  ],
  grace: 0.35,
  perks: { feeDiscount: true, poolAnalysis: false }
};

/** "0.2%" for basis points. */
export const bpsText = (bps) => `${Number((bps / 100).toFixed(3))}%`;

/** Whether KINU charges any fee of its own on swaps (the platform fee or the Intear referral fee). */
export const SWAP_FEE_LIVE = PLATFORM_FEE.enabled || INTEAR_FEE.live;

const PLATFORM_FEE_LINE = `Swaps include a ${bpsText(PLATFORM_FEE.bps)} KINU platform fee (on Zap In and Rebalance, only on the part that is swapped; none on $KINU swaps or on adding or removing liquidity in a pool's own form), shown before you sign and paid to ${PLATFORM_FEE.treasury}.`;
const QUICK_LP_FEE_LINE = `Quick LP (the one-tap panel, also opened by the KINU LP bot) adds a ${bpsText(QUICK_LP_FEE.bps)} convenience fee on what goes into a new position, at most $${QUICK_LP_FEE.maxUsd} per position; closing, claiming and a pool's own form are free.`;
const INTEAR_FEE_LINE = `Swaps routed through the Intear aggregator include a ${bpsText(INTEAR_FEE.bps)} fee instead${INTEAR_FEE.stableBps !== INTEAR_FEE.bps ? ` (${bpsText(INTEAR_FEE.stableBps)} on stable pairs)` : ''}: 80% to ${INTEAR_REFERRER}, 20% to Intear; shown before you sign.`;

const HOLDER_FEE_LINE = !HOLDER.enabled || !HOLDER.perks.feeDiscount ? '' : `$KINU holders pay less on KINU's own fees: ${HOLDER.tiers.map(([usd, off]) => `${off * 100}% off from $${usd}`).join(', ')} of KINU in the wallet.`;

/** One line describing KINU's fees, for the landing, Security and Docs. */
export const FEE_SUMMARY = SWAP_FEE_LIVE
  ? [PLATFORM_FEE.enabled ? PLATFORM_FEE_LINE : 'No fee on Rhea routes.', INTEAR_FEE.live ? INTEAR_FEE_LINE : '', QUICK_LP_FEE.enabled ? QUICK_LP_FEE_LINE : '', HOLDER_FEE_LINE].filter(Boolean).join(' ')
  : 'No platform fee today. Any future fee will be shown before you sign.';

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
