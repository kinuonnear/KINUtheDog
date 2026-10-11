# KINU Rhea Terminal v0.2.0 — Meteor Only

Custom NEAR Mainnet terminal using Meteor Wallet as the only wallet connection path.

## Current phase
- Meteor Wallet connect / disconnect
- NEAR Mainnet account detection
- Live NEAR balance via NEAR RPC
- Rhea pool explorer using the NEAR mainnet Rhea contract `v2.ref-finance.near`
- Live pool reads through `get_pools` with `finality: final`
- AMM (`SIMPLE_POOL`) and Stable (`STABLE_SWAP` / `RATED_SWAP`) classification
- Search, filter and fee sorting
- No mock pool numbers
- No seed phrase / private key handling

## Next phases
1. Rhea V2 ALMM / CLMM discovery layer
2. Pool detail + token metadata
3. SmartRouter quotes
4. Meteor-signed swap transactions
5. Add / remove liquidity transaction builders

## Run
```powershell
npm install
npm run dev -- --force
```

The pool explorer reads directly from NEAR RPC, so the browser must be able to reach `https://rpc.mainnet.near.org`.
