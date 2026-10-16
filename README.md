<p align="center">
  <img src="https://kinudefi.com/icon-512.png" alt="KINU" width="128" height="128">
</p>

<h1 align="center">KINU — Liquidity Terminal on NEAR</h1>

<p align="center">
  <b>The dog that follows the flow.</b><br>
  Swap, open and manage concentrated liquidity on NEAR — clearly, and without giving up your keys.
</p>

<p align="center">
  <a href="https://kinudefi.com"><b>kinudefi.com</b></a> ·
  <a href="https://x.com/KINUonNEAR">X / @KINUonNEAR</a> ·
  <a href="https://kinudefi.com/docs">Docs</a> ·
  <a href="https://kinudefi.com/security">Security</a>
</p>

---

## What KINU is

KINU is a non-custodial web app for liquidity providers on NEAR. It is built on
**[Rhea Finance](https://app.rhea.finance)** (formerly Ref Finance): every pool, swap and position is Rhea's, read live
from the chain. KINU makes them easier to understand and to act on — and every action is signed in your own wallet.

**Status:** live on NEAR mainnet at [kinudefi.com](https://kinudefi.com). Open source. No platform fee today.

## Features

| | |
| --- | --- |
| **Swap** | Best route across Rhea's AMM, stable and CLMM pools (Rhea SmartRouter + aggregator), with direct CLMM routing for pairs the router doesn't cover. Native NEAR ⇄ wNEAR, USD charts, live trades, price-impact warnings. |
| **Pools** | Every Rhea pool — AMM, CLMM, ALMM, Stable, Farm — with live TVL, volume and fee APR, search and sorting. |
| **CLMM range builder** | Meteora-style: a range slider with real handles under the pool's liquidity depth, price and % tags on the range edges, Min / Max in the pool's units and in USD, presets, tick steppers and Spot / Curve / Bid-Ask shapes. What you set is what you sign. |
| **Manage positions** | Click a position and the side panel becomes yours: **add liquidity** on the same range, **remove** some or all of it, or **rebalance** around the current price. PnL per position, fees included. |
| **Zap in / out** | Deposit a single token and KINU swaps the right share into the pair; withdraw everything as one token. |
| **Portfolio** | Net worth across wallet tokens, classic LP, CLMM ranges and tokens parked in Rhea. Any account can be viewed read-only. |
| **Discover & Smart LP** | Trending tokens, hot pairs and the best pools to LP — plus public LP wallet profiles (PnL, fees earned, win rate) to learn from. |
| **KINU Agent** *(beta)* | An LP co-pilot in the browser: it scans Rhea pools and your positions and explains every call. Analytics only — nothing moves until you sign it. |

Wallets: Meteor, Intear, HOT (Here), MyNearWallet.

## Security

KINU never holds keys or funds. Before your wallet opens, every request is checked:

- **Only Rhea, only known methods** — transactions go to an allow-list of Rhea contracts and methods.
- **Tokens only go to Rhea** — never to any other account.
- **No transfers, key changes or deploys** — always refused.
- **Fees are capped** — registration fees and per-request totals have hard limits.
- **Quotes must match** — a route that would spend a different amount or trade a different pair is rejected.

The site runs with a strict Content-Security-Policy, HTTPS only, no secrets in the app and no published source maps.
Details: [kinudefi.com/security](https://kinudefi.com/security).

KINU is software, not financial advice. Providing liquidity carries risk (including impermanent loss) — start small.

## Built with

NEAR · Rhea Finance (AMM, DCL / CLMM, SmartRouter, aggregator) · Intear price indexer · FastNEAR · NEAR Wallet Selector ·
React + Vite, deployed as a static site (no backend).

## Get involved

We're building KINU for the long run and welcome:

- **Feedback** from LPs and traders — open an issue or reach us on [X](https://x.com/KINUonNEAR).
- **Collaborators** — front-end, data, and Rust/NEAR smart contracts.
- **Reviewers / auditors** — security reviews of the transaction flows are always welcome.

---

## For developers

### Data sources

| Data | Source |
| --- | --- |
| Pools, TVL, volume, APR | `api.rhea.finance/pool/search` |
| Token prices | `indexer.ref.finance/list-token-price` |
| Swap routes | `smartx.rhea.finance/swapMultiDexPath`, fallback: `dclv2.ref-labs.near` `quote` |
| Live pool state, LP shares, deposits | `v2.ref-finance.near`, `dclv2.ref-labs.near`, `boostfarm.ref-labs.near` |
| Wallet balances | FastNEAR FT index + NEAR RPC |
| Charts, token stats, recent trades | Intear price indexer (`prices.intear.tech`) |

All endpoints allow CORS, so there is no backend or proxy.

### Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static output in dist/
npm run preview    # serve the production build
```

Requires Node 20+.

### Deploy

`dist/` can be hosted on any static host. The app uses clean URLs (`/swap`, `/pools/123`), so unknown paths must
fall back to `index.html`:

- **Vercel**: handled by `vercel.json`.
- **Netlify**: handled by `public/_redirects`.
- **Nginx**: `try_files $uri /index.html;`

### Project structure

```
src/
  config.js            contracts, endpoints, gas & deposit constants
  lib/
    rpc.js             NEAR RPC client (failover, caching, concurrency limit)
    rhea.js            Rhea pools, pool state, LP / CLMM / farm positions, deposits
    swap.js            SmartRouter quotes + aggregator swap transactions
    dclRouter.js       direct DCL (CLMM) routing fallback
    liquidity.js       AMM / Stable / ALMM deposit + withdraw transactions
    dclLiquidity.js    CLMM price-range math, positions, deposit / add / withdraw
    zap.js             single-token zap in / out
    txGuard.js         allow-list checks on every request before the wallet opens
    lpHistory.js       position history and PnL
    agent.js           KINU Agent scoring (read-only)
    wallet.js          wallet-selector setup and signing
  pages/               Welcome, Home, Swap, Pools, PoolDetail, Portfolio, Discover, Agent, Docs, Security, …
  components/          range builder, position panel, charts, liquidity forms, shared UI
  state.jsx            wallet session, prices, balances, toasts, settings
  router.jsx           client-side routing
```

### Notes

- Mainnet only. Test with small amounts first.
- The swap "price impact" is an estimate from indexer USD prices; thin pools show high impact and the swap button
  warns above 15%.
