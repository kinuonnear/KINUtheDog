# KINU — DeFi terminal on NEAR

A non-custodial web platform for **swapping**, **providing liquidity** and **tracking a DeFi portfolio** on NEAR.
All on-chain data comes from **[Rhea Finance](https://app.rhea.finance)** (formerly Ref Finance).

## Features

| Area | What it does |
| --- | --- |
| **Swap aggregator** | Best route across Rhea AMM, stable and CLMM pools via Rhea's SmartRouter, executed through the Rhea aggregator contract (`aggregatedex.near`) exactly like app.rhea.finance. Pairs the router doesn't cover (e.g. **KINU**, which only trades in community CLMM pools) are routed directly through Rhea DCL pools (1- and 2-hop, quoted on-chain). Native NEAR ⇄ wNEAR wrap/unwrap. Intear-style USD chart (1m–1W, Price/MCap, OHLC legend, volume), token stats and live recent trades. Price-impact estimate, slippage settings. |
| **Pools** | Every Rhea pool with live TVL, 24h volume and APR, grouped like app.rhea.finance: **AMM**, **CLMM**, **ALMM**, **Stable** and **Farm**, plus search and sorting. |
| **Liquidity** | Deposit and withdraw in-app for every pool type: AMM (auto-paired amounts), Stable & ALMM (any ratio, shares predicted on-chain), CLMM (price-range presets or custom min/max, range preview, per-position removal). NEAR auto-wraps; storage registration is handled. |
| **Portfolio** | Net worth across wallet tokens, classic LP positions (incl. farm-staked shares), CLMM ranges and tokens parked in the Rhea exchange, with one-click "withdraw all". Any account can be viewed read-only via `/portfolio?account=name.near`. |

Wallets: Meteor, Intear, HOT (Here), MyNearWallet. **KINU never handles keys** — every transaction is reviewed and signed in the user's wallet.

## Data sources

| Data | Source |
| --- | --- |
| Pools, TVL, volume, APR | `api.rhea.finance/pool/search` |
| Token prices | `indexer.ref.finance/list-token-price` |
| Swap routes | `smartx.rhea.finance/swapMultiDexPath`, fallback: `dclv2.ref-labs.near` `quote` |
| Live pool state, LP shares, deposits | `v2.ref-finance.near`, `dclv2.ref-labs.near`, `boostfarm.ref-labs.near` |
| Wallet balances | FastNEAR FT index + NEAR RPC |
| Charts, token stats, recent trades | Intear price indexer (`prices.intear.tech`) |

All endpoints allow CORS, so there is no backend or proxy: the build is a static site.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static output in dist/
npm run preview    # serve the production build
```

Requires Node 20+.

## Deploy

`dist/` can be hosted on any static host. The app uses clean URLs (`/swap`, `/pools/123`), so unknown paths must
fall back to `index.html`:

- **Netlify**: handled by `public/_redirects`.
- **Vercel**: handled by `vercel.json`.
- **Nginx**: `try_files $uri /index.html;`

## Project structure

```
src/
  config.js            contracts, endpoints, gas & deposit constants
  lib/
    rpc.js             NEAR RPC client (failover, caching, concurrency limit)
    format.js          BigInt-safe amount / USD / percent formatting
    tokens.js          token metadata cache, prices, balances
    rhea.js            Rhea pools, pool state, LP/CLMM/farm positions, deposits
    swap.js            SmartRouter quotes + aggregator swap transactions
    dclRouter.js       direct DCL (CLMM) routing fallback
    liquidity.js       AMM / Stable / ALMM deposit + withdraw transactions
    dclLiquidity.js    CLMM price-range math, positions, deposit + withdraw
    tx.js              transaction helpers (storage registration, wrap, merge)
    wallet.js          wallet-selector setup and signing
    intear.js          USD candles, token stats, recent trades
  pages/               Home, Swap, Pools, PoolDetail, Portfolio
  components/          shared UI, TokenPicker, PriceChart, RecentTrades, Liquidity
  state.jsx            wallet session, prices, balances, toasts, settings
  router.jsx           client-side routing
```

## Notes

- Mainnet only. Test with small amounts first.
- The swap "price impact" is an estimate from indexer USD prices; thin pools (e.g. KINU/NINU) show high impact and the
  swap button warns above 15%.
