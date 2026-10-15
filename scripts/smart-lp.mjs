// Smart LP snapshot (KINU team only): finds the wallets that added Rhea CLMM liquidity in the last
// 30 days, reads each one's on-chain LP history and writes their stats to
// public/smart-lp/board.json. The Discover → Smart LP board only reads that file; publish a new
// snapshot by committing it.
//
//   npm run smart-lp                 last 30 days
//   npm run smart-lp -- --days 60    a longer window

import { mkdir, writeFile } from 'node:fs/promises';
import { getPrices } from '../src/lib/tokens.js';
import { buildLpModel, loadLpHistory } from '../src/lib/lpStats.js';
import { dclRowsFor, discoverLpWallets, walletCard } from '../src/lib/smartLp.js';

const FILE = new URL('../public/smart-lp/board.json', import.meta.url);
const argDays = process.argv.indexOf('--days');
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) || 30 : 30;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const accounts = await discoverLpWallets({ days: DAYS, onPage: (page, found) => console.log(`  page ${page}: ${found} wallets`) });
console.log(`${accounts.length} wallets added CLMM liquidity in the last ${DAYS} days`);
const prices = await getPrices();

const wallets = [];
for (const [i, account] of accounts.entries()) {
  try {
    const [raw, rows] = await Promise.all([loadLpHistory(account), dclRowsFor(account, prices)]);
    const card = walletCard(account, buildLpModel(raw, rows, prices));
    if (card.totalPositions > 0) wallets.push(card);
    console.log(`[${i + 1}/${accounts.length}] ${account}: ${card.totalPositions} positions, PnL $${card.totalPnl}`);
  } catch (error) {
    console.log(`[${i + 1}/${accounts.length}] ${account}: skipped (${error.message})`);
  }
  await sleep(1_500); // NearBlocks' free tier: keep a steady pace
}

await mkdir(new URL('./', FILE), { recursive: true });
await writeFile(FILE, `${JSON.stringify({ version: 1, generatedAt: Date.now(), days: DAYS, wallets })}\n`);
console.log(`Wrote ${wallets.length} wallets to public/smart-lp/board.json`);
process.exit(0);
