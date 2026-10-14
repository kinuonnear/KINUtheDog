// KINU Agent (/agent): an LP co-pilot in the browser. Every 90s (while the tab is visible) it scans
// Rhea's most active pools and the account's positions (lib/agent.js) and posts its calls with
// reasons to a live feed. It only reads: each suggested action opens the normal KINU flow, which
// the user signs in their own wallet. No server, no custody.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useLocalStorage } from '../hooks.js';
import { Link, poolPath, useLocation } from '../router.jsx';
import { getPoolRadar } from '../lib/poolRadar.js';
import { getClassicPositions, getDclPositions } from '../lib/rhea.js';
import { getTokens, priceOf } from '../lib/tokens.js';
import { judgeClassicHolding, judgeDclHolding, PERSONAS, scanPools } from '../lib/agent.js';
import { formatPercent, formatUsd } from '../lib/format.js';
import { PairIcons, Spinner } from '../components/ui.jsx';
import { usePoolTokens } from './Pools.jsx';

const SCAN_MS = 90_000;
const FEED_MAX = 40;

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function Verdict({ verdict }) {
  return <span className={`ag-verdict ag-verdict--${verdict.toLowerCase()}`}>{verdict}</span>;
}

/** Seconds until the next scan, ticking. */
function useCountdown(updatedAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return updatedAt ? Math.max(0, Math.round((updatedAt + SCAN_MS - now) / 1000)) : null;
}

/** The account's holdings, grouped per pool, with USD value and unclaimed fees. */
function useHoldings(account) {
  const { prices } = useApp();
  const data = useAsync(
    async () => {
      const [dcl, classic] = await Promise.all([getDclPositions(account), getClassicPositions(account).catch(() => [])]);
      const ids = [...new Set(dcl.flatMap((p) => [p.tokenX, p.tokenY]))];
      const tokens = ids.length ? await getTokens(ids) : {};
      return { dcl, classic, tokens };
    },
    [account],
    { enabled: Boolean(account), refreshMs: 120_000 }
  );
  const groups = useMemo(() => {
    if (!data.data) return null;
    const { dcl, classic, tokens } = data.data;
    const byPool = new Map();
    dcl.forEach((p) => byPool.set(p.poolId, [...(byPool.get(p.poolId) || []), p]));
    const usdOf = (id, raw) => (Number(raw) / 10 ** (tokens[id]?.decimals ?? 24)) * priceOf(prices, id);
    const dclGroups = [...byPool.entries()].map(([poolId, positions]) => {
      const [x, y] = [positions[0].tokenX, positions[0].tokenY];
      const value = positions.reduce((s, p) => s + usdOf(x, p.amountX) + usdOf(y, p.amountY), 0);
      const fees = positions.reduce((s, p) => s + usdOf(x, p.unclaimedFeeX) + usdOf(y, p.unclaimedFeeY), 0);
      return { kind: 'dcl', poolId, positions, tokenIds: [x, y], usd: { value, fees } };
    });
    const classicGroups = classic.map((c) => ({
      kind: 'classic',
      poolId: String(c.pool.id),
      tokenIds: c.pool.tokenIds,
      label: c.pool.label,
      usd: { value: c.pool.tokenIds.reduce((s, id, i) => s + usdOf(id, c.amounts[i]), 0), fees: 0 }
    }));
    return [...dclGroups, ...classicGroups].sort((a, b) => b.usd.value - a.usd.value);
  }, [data.data, prices]);
  return { groups, loading: data.loading && !data.data, error: data.data ? null : data.error, reload: data.reload };
}

export default function Agent() {
  const { accountId, connect } = useApp();
  const { search } = useLocation();
  const account = search.get('account') || accountId;
  const [personaKey, setPersonaKey] = useLocalStorage('kinu.agent.persona', 'guardian');
  const persona = PERSONAS.find((p) => p.key === personaKey) || PERSONAS[0];

  const radar = useAsync(getPoolRadar, [], { refreshMs: SCAN_MS });
  const radarById = useMemo(() => new Map((radar.data || []).map((r) => [String(r.id), r])), [radar.data]);
  const scan = useMemo(() => (radar.data ? scanPools(radar.data, persona) : null), [radar.data, persona]);
  const holdings = useHoldings(account);
  const calls = useMemo(
    () =>
      (holdings.groups || []).map((g) => ({
        ...g,
        call: g.kind === 'dcl' ? judgeDclHolding({ positions: g.positions, usd: g.usd, radarRow: radarById.get(g.poolId) }) : judgeClassicHolding({ radarRow: radarById.get(g.poolId) })
      })),
    [holdings.groups, radarById]
  );
  const next = useCountdown(radar.updatedAt);

  // Pair tokens for icons: the opportunity / trap rows and the holdings.
  const iconPools = useMemo(
    () => [...(scan?.picks || []).map((c) => c.row), ...(scan?.traps || []).map((c) => c.row), ...calls.map((c) => ({ id: c.poolId, tokenIds: c.tokenIds }))],
    [scan, calls]
  );
  const tokensOf = usePoolTokens(iconPools);
  const symbolsOf = (pool) => tokensOf(pool).map((t) => t.symbol).join(' / ');

  // The live feed: each scan posts what the agent looked at and decided.
  const [feed, setFeed] = useState([]);
  const lastPosted = useRef('');
  useEffect(() => {
    if (!scan || !radar.updatedAt) return;
    const key = `${radar.updatedAt}|${persona.key}|${calls.length}`;
    if (key === lastPosted.current) return;
    lastPosted.current = key;
    const t = Date.now();
    const entries = [
      { kind: 'scan', text: `scan · ${scan.scanned} active Rhea pools · ${scan.passed} pass the fee-coverage test · persona ${persona.name}` },
      ...calls.slice(0, 4).map((c) => ({ kind: c.call.verdict.toLowerCase(), text: `${symbolsOf({ id: c.poolId, tokenIds: c.tokenIds })} · ${c.call.verdict.toLowerCase()} — ${c.call.reasons[0]}` })),
      ...scan.picks.slice(0, 3).map((c) => ({ kind: c.verdict.toLowerCase(), text: `${symbolsOf(c.row)} · ${c.verdict.toLowerCase()} — ${c.reasons[0]}` })),
      ...scan.traps.slice(0, 2).map((c) => ({ kind: 'avoid', text: `${symbolsOf(c.row)} · avoid — ${c.reasons[0]}` }))
    ].map((e, i) => ({ ...e, id: `${t}-${i}`, t }));
    setFeed((prev) => [...entries, ...prev].slice(0, FEED_MAX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan, radar.updatedAt, persona.key, calls]);

  return (
    <div className="page page--agent">
      <header className="ag-hero">
        <div>
          <span className="ag-badge">
            <i className="ag-pulse" aria-hidden /> Live · beta
          </span>
          <h1>KINU Agent</h1>
          <p>Your LP co-pilot. It scans Rhea pools and your positions, and explains every call. You stay in control — nothing moves until you sign it.</p>
        </div>
        <div className="ag-status">
          <div>
            <span>Pools scanned</span>
            <strong>{scan ? scan.scanned : '—'}</strong>
          </div>
          <div>
            <span>Pass fee coverage</span>
            <strong>{scan ? scan.passed : '—'}</strong>
          </div>
          <div>
            <span>Next scan</span>
            <strong>{radar.loading && !radar.data ? <Spinner size={14} /> : next !== null ? `${next}s` : '—'}</strong>
          </div>
        </div>
      </header>

      <section className="ag-personas" aria-label="Agent persona">
        {PERSONAS.map((p) => (
          <button key={p.key} type="button" className={`ag-persona ${p.key === persona.key ? 'ag-persona--on' : ''}`} onClick={() => setPersonaKey(p.key)}>
            <span className="ag-persona__icon" aria-hidden>
              {p.icon}
            </span>
            <span>
              <strong>{p.name}</strong>
              <small>{p.tagline}</small>
            </span>
            <em>{p.text}</em>
          </button>
        ))}
      </section>

      <div className="ag-grid">
        <div className="ag-main">
          <section className="ag-card">
            <h2>Your positions</h2>
            {!account ? (
              <div className="ag-empty">
                <p>Connect your wallet and the agent reviews every position: in range, near an edge, fees to compound, or time to rebalance.</p>
                <button type="button" className="button button--primary" onClick={connect}>
                  Connect wallet
                </button>
              </div>
            ) : holdings.loading ? (
              <div className="ag-empty">
                <Spinner size={16} /> <span className="muted">Reading your positions…</span>
              </div>
            ) : holdings.error ? (
              // Not "no liquidity": the read failed (RPC busy), so say that and offer a retry.
              <div className="ag-empty">
                <p>Couldn&apos;t read your positions right now (network busy).</p>
                <button type="button" className="button button--ghost button--sm" onClick={holdings.reload}>
                  Try again
                </button>
              </div>
            ) : !calls.length ? (
              <div className="ag-empty">
                <p>No liquidity yet. Pick a pool from the agent&apos;s list below — or start with <Link to="/start-lp">How to start LP</Link>.</p>
              </div>
            ) : (
              <div className="ag-list">
                {calls.map((c) => (
                  <article key={c.poolId} className={`ag-call ag-call--${c.call.tone}`}>
                    <div className="ag-call__head">
                      <PairIcons tokens={tokensOf({ id: c.poolId, tokenIds: c.tokenIds })} size={26} />
                      <strong>{symbolsOf({ id: c.poolId, tokenIds: c.tokenIds })}</strong>
                      <small className="muted">
                        {c.kind === 'dcl' ? 'CLMM' : c.label} · {formatUsd(c.usd.value)}
                      </small>
                      <Verdict verdict={c.call.verdict} />
                    </div>
                    <ul>
                      {c.call.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    <div className="ag-call__actions">
                      {(c.call.verdict === 'REBALANCE' || c.call.verdict === 'COMPOUND') && (
                        <Link to="/portfolio" className="button button--primary button--sm">
                          {c.call.verdict === 'REBALANCE' ? '⟲ Rebalance in Portfolio' : '↻ Compound in Portfolio'}
                        </Link>
                      )}
                      <Link to={poolPath(c.poolId)} className="button button--ghost button--sm">
                        Open pool
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="ag-card">
            <h2>
              Opportunities <small>· {persona.name}</small>
            </h2>
            {!scan && radar.error ? (
              <div className="ag-empty">
                <p>Couldn&apos;t load pool data right now — the agent will retry on its next scan.</p>
                <button type="button" className="button button--ghost button--sm" onClick={radar.reload}>
                  Scan now
                </button>
              </div>
            ) : !scan ? (
              <div className="ag-empty">
                <Spinner size={16} /> <span className="muted">Scanning Rhea pools…</span>
              </div>
            ) : !scan.picks.length ? (
              <div className="ag-empty">
                <p>Nothing passes {persona.name}&apos;s filters right now. Try another persona or check back after the next scan.</p>
              </div>
            ) : (
              <div className="ag-list">
                {scan.picks.map((c) => (
                  <article key={c.row.id} className="ag-call ag-call--up">
                    <div className="ag-call__head">
                      <PairIcons tokens={tokensOf(c.row)} size={26} />
                      <strong>{symbolsOf(c.row)}</strong>
                      <small className="muted">
                        {c.row.label} · TVL {formatUsd(c.metrics.tvl)} · APR {formatPercent(c.metrics.apr, 0)}
                      </small>
                      <Verdict verdict={c.verdict} />
                    </div>
                    <ul>
                      {c.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    <div className="ag-call__actions">
                      <Link to={`${poolPath(c.row.id)}?tab=add`} className="button button--primary button--sm">
                        + Add LP
                      </Link>
                      <Link to={poolPath(c.row.id)} className="button button--ghost button--sm">
                        Open pool
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {scan?.traps.length > 0 && (
            <section className="ag-card">
              <h2>
                Yield traps <small>· high APR, but fees lose to the price swing</small>
              </h2>
              <div className="ag-list">
                {scan.traps.map((c) => (
                  <article key={c.row.id} className="ag-call ag-call--down">
                    <div className="ag-call__head">
                      <PairIcons tokens={tokensOf(c.row)} size={26} />
                      <strong>{symbolsOf(c.row)}</strong>
                      <small className="muted">
                        {c.row.label} · APR {formatPercent(c.metrics.apr, 0)}
                      </small>
                      <Verdict verdict="AVOID" />
                    </div>
                    <ul>
                      {c.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="ag-feed" aria-label="Agent activity">
          <div className="ag-feed__head">
            <h2>Activity</h2>
            <span className="muted small">{feed.length ? `last ${clock(feed[0].t)}` : 'waiting for the first scan'}</span>
          </div>
          <ol>
            {feed.map((e) => (
              <li key={e.id} className={`ag-log ag-log--${e.kind}`}>
                <time>{clock(e.t)}</time>
                <span>{e.text}</span>
              </li>
            ))}
          </ol>
          <p className="ag-feed__note">
            Calls are rule-based on live Rhea data — fee coverage = 24h fees ÷ the impermanent loss of the 24h price move. Not
            financial advice: the agent explains, you decide.
          </p>
        </aside>
      </div>
    </div>
  );
}
