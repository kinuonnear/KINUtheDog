// Smart LP snapshot (KINU team only): finds the wallets that added Rhea CLMM liquidity in the last
// 90 days, reads each one's on-chain LP history and writes their stats to
// public/smart-lp/board.json. The Discover → Smart LP board only reads that file; publish a new
// snapshot by committing it.
//
//   npm run smart-lp                 last 90 days
//   npm run smart-lp -- --days 30    a shorter window
//   npm run smart-lp -- --reuse      refresh the wallets already on the board (no discovery: spares
//                                    NearBlocks' small free quota)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getPrices } from '../src/lib/tokens.js';
import { buildLpModel, loadLpHistory } from '../src/lib/lpStats.js';
import { dclRowsFor, discoverLpWallets, walletCard } from '../src/lib/smartLp.js';

const FILE = new URL('../public/smart-lp/board.json', import.meta.url);
const argDays = process.argv.indexOf('--days');
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) || 90 : 90;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reuse = process.argv.includes('--reuse');
const previous = reuse ? JSON.parse(await readFile(FILE, 'utf8')) : null;
const days = previous?.days || DAYS;
const accounts = previous
  ? previous.wallets.map((w) => w.account)
  : await discoverLpWallets({ days: DAYS, onPage: (page, found, note) => console.log(`  page ${page}: ${found} wallets${note ? ` (${note})` : ""}`) });
console.log(previous ? `Refreshing ${accounts.length} wallets from the current board` : `${accounts.length} wallets added CLMM liquidity in the last ${DAYS} days`);
const prices = await getPrices();

const wallets = [];
for (const [i, account] of accounts.entries()) {
  try {
    const rows = await dclRowsFor(account, prices);
    // A partial history usually means NearBlocks rate-limited us mid-run: rest, then read again.
    let raw = await loadLpHistory(account);
    for (let retry = 0; !raw.complete && retry < 2; retry += 1) {
      console.log(`  ${account}: partial history, retrying in 45s`);
      await sleep(45_000);
      raw = await loadLpHistory(account);
    }
    const card = walletCard(account, buildLpModel(raw, rows, prices));
    // No liquidity events of its own: it adds liquidity on behalf of others.
    if (card.totalPositions > 0 && card.lastActivity) wallets.push(card);
    console.log(`[${i + 1}/${accounts.length}] ${account}: ${card.totalPositions} positions, PnL $${card.totalPnl}`);
  } catch (error) {
    console.log(`[${i + 1}/${accounts.length}] ${account}: skipped (${error.message})`);
  }
  await sleep(3_000); // NearBlocks' free tier: keep a steady pace
}

await mkdir(new URL('./', FILE), { recursive: true });
await writeFile(FILE, `${JSON.stringify({ version: 1, generatedAt: Date.now(), days, wallets })}\n`);
console.log(`Wrote ${wallets.length} wallets to public/smart-lp/board.json`);
process.exit(0);
