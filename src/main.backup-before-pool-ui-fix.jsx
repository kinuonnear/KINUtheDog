import React, {
  useEffect,
  useMemo,
  useState
} from 'react';

import { createRoot } from 'react-dom/client';

import './styles.css';
import '@near-wallet-selector/modal-ui/styles.css';

import {
  initMeteorWallet,
  connectWallet,
  disconnectMeteor,
  destroyMeteor,
  getNearAccountBalance
} from './wallet.js';

import {
  fetchRheaPools,
  fetchTokenMetadata
} from './rhea';


/* =========================================================
   HELPERS
   ========================================================= */

function shortAddress(account) {
  if (!account) return '';

  return account.length > 22
    ? `${account.slice(0, 10)}â€¦${account.slice(-8)}`
    : account;
}


function formatNear(yocto) {
  if (!yocto) return '0';

  const n = Number(yocto) / 1e24;

  return Number.isFinite(n)
    ? n.toLocaleString(undefined, {
        maximumFractionDigits: 6
      })
    : 'â€”';
}


function formatPoolId(id) {
  return `#${id}`;
}


function formatFee(fee) {
  if (
    fee === null ||
    fee === undefined
  ) {
    return 'â€”';
  }

  return `${fee / 100}%`;
}


/* =========================================================
   TOKEN AMOUNT FORMATTER
   ========================================================= */

function formatTokenAmount(
  amount,
  decimals
) {
  if (
    amount === null ||
    amount === undefined
  ) {
    return 'â€”';
  }

  if (
    decimals === null ||
    decimals === undefined
  ) {
    return String(amount);
  }

  try {
    const raw = BigInt(String(amount));

    const negative = raw < 0n;

    const absolute = negative
      ? -raw
      : raw;

    const base =
      10n ** BigInt(decimals);

    const whole =
      absolute / base;

    const fraction =
      absolute % base;

    if (fraction === 0n) {
      return `${negative ? '-' : ''}${whole}`;
    }

    let fractionText =
      fraction
        .toString()
        .padStart(decimals, '0');

    fractionText =
      fractionText.replace(/0+$/, '');

    return (
      `${negative ? '-' : ''}` +
      `${whole}.` +
      fractionText
    );

  } catch {
    return String(amount);
  }
}


/* =========================================================
   AMM SPOT PRICE
   ========================================================= */

/*
 * Calculates:
 *
 * TOKEN B per TOKEN A
 *
 * using the actual on-chain reserves
 * and token decimals.
 *
 * This is intended for AMM / SIMPLE_POOL.
 *
 * It is NOT used as the final pricing formula
 * for Stable, ALMM, or CLMM pools.
 */

function calculateSpotPrice(
  reserveA,
  decimalsA,
  reserveB,
  decimalsB
) {
  if (
    reserveA === null ||
    reserveA === undefined ||
    reserveB === null ||
    reserveB === undefined
  ) {
    return null;
  }

  if (
    decimalsA === null ||
    decimalsA === undefined ||
    decimalsB === null ||
    decimalsB === undefined
  ) {
    return null;
  }

  try {
    const rawA =
      BigInt(String(reserveA));

    const rawB =
      BigInt(String(reserveB));

    if (
      rawA === 0n ||
      rawB === 0n
    ) {
      return null;
    }

    /*
     * Convert raw reserves into
     * human-readable quantities.
     *
     * We deliberately do not use
     * Number(rawA) directly.
     */

    const humanA =
      Number(
        formatTokenAmount(
          rawA,
          decimalsA
        )
      );

    const humanB =
      Number(
        formatTokenAmount(
          rawB,
          decimalsB
        )
      );

    if (
      !Number.isFinite(humanA) ||
      !Number.isFinite(humanB) ||
      humanA === 0
    ) {
      return null;
    }

    return humanB / humanA;

  } catch {
    return null;
  }
}


function formatSpotPrice(price) {
  if (
    price === null ||
    price === undefined ||
    !Number.isFinite(price)
  ) {
    return 'â€”';
  }

  if (price === 0) {
    return '0';
  }

  if (price >= 1) {
    return price.toLocaleString(
      undefined,
      {
        maximumFractionDigits: 6
      }
    );
  }

  return price.toLocaleString(
    undefined,
    {
      maximumSignificantDigits: 8
    }
  );
}


/* =========================================================
   TOKEN DISPLAY
   ========================================================= */

function TokenDisplay({
  tokenId,
  metadata,
  label
}) {
  const [menuOpen, setMenuOpen] =
    useState(false);

  const symbol =
    metadata?.symbol ||
    tokenId ||
    'â€”';

  const icon =
    metadata?.icon ||
    null;

  const copyAddress = async () => {
    if (!tokenId) return;

    try {
      await navigator.clipboard.writeText(
        tokenId
      );

      setMenuOpen(false);
    } catch (error) {
      console.error(
        '[KINU] Failed to copy token address',
        error
      );
    }
  };

  const openExplorer = () => {
    if (!tokenId) return;

    window.open(
      `https://nearblocks.io/address/${encodeURIComponent(tokenId)}`,
      '_blank',
      'noopener,noreferrer'
    );

    setMenuOpen(false);
  };

  return (
    <div className="pool-token">

      <small>
        {label}
      </small>

      <button
        type="button"
        className="token-name-button"
        onClick={() =>
          setMenuOpen(
            (previous) => !previous
          )
        }
      >

        {icon ? (
          <img
            src={icon}
            alt=""
            className="token-icon"
          />
        ) : (
          <span className="token-icon token-icon-fallback">
            {symbol
              .slice(0, 1)
              .toUpperCase()}
          </span>
        )}

        <strong>
          {symbol}
        </strong>

      </button>

      {metadata?.name &&
        metadata.name !== symbol && (
          <span className="token-name">
            {metadata.name}
          </span>
        )}

      {menuOpen && (
        <div className="token-action-menu">

          <div className="token-address">
            {tokenId}
          </div>

          <button
            type="button"
            onClick={copyAddress}
          >
            ðŸ“‹ Copy address
          </button>

          <button
            type="button"
            onClick={openExplorer}
          >
            â†— Block explorer
          </button>

        </div>
      )}

    </div>
  );
}


/* =========================================================
   SWAP UI â€” JUPITER-STYLE TOKEN SELECTOR
   ========================================================= */

const PINNED_TOKENS = [
  { symbol: 'KINU', name: 'KINU', address: 'kinu.nearlytrade.near' },
  { symbol: 'NINU', name: 'NINU', address: 'ninu-4.nearlytrade.near' },
  { symbol: 'RHEA', name: 'RHEA', address: 'token.rhealab.near' },
  { symbol: 'NEAR', name: 'NEAR', address: 'wrap.near' },
  { symbol: 'NEARLY', name: 'NEARLY', address: 'nearly-993927.nearlytrade.near' },
  { symbol: 'DIARHEA', name: 'DIARHEA', address: 'diarhea.nearlytrade.near' },
  { symbol: 'USDC', name: 'USD Coin', address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' },
  { symbol: 'USDT', name: 'Tether USD', address: 'usdt.tether-token.near' }
];

function SwapTokenIcon({ token }) {
  if (token?.metadata?.icon) {
    return (
      <img
        src={token.metadata.icon}
        alt=""
        className="swap-token-icon"
      />
    );
  }

  return (
    <span className="swap-token-icon swap-token-icon-fallback">
      {(token?.symbol || '?').slice(0, 1)}
    </span>
  );
}

function SwapTokenPicker({
  title,
  selected,
  onSelect,
  onClose
}) {
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState(PINNED_TOKENS);
  const [metadata, setMetadata] = useState({});
  const [loadingAddress, setLoadingAddress] = useState(false);

  useEffect(() => {
    let mounted = true;

    Promise.all(
      pinned.map(async (token) => {
        try {
          const result = await fetchTokenMetadata(token.address);
          return [token.address, result];
        } catch {
          return [token.address, null];
        }
      })
    ).then((entries) => {
      if (!mounted) return;

      setMetadata((previous) => ({
        ...previous,
        ...Object.fromEntries(entries)
      }));
    });

    return () => {
      mounted = false;
    };
  }, [pinned]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q) return pinned;

    return pinned.filter((token) => (
      token.symbol.toLowerCase().includes(q) ||
      token.name.toLowerCase().includes(q) ||
      token.address.toLowerCase().includes(q)
    ));
  }, [pinned, query]);

  const choosePinned = (token) => {
    onSelect({
      ...token,
      metadata: metadata[token.address] || null
    });
    onClose();
  };

  const useContract = async () => {
    const address = query.trim();

    if (!address) return;

    setLoadingAddress(true);

    try {
      const result = await fetchTokenMetadata(address);

      onSelect({
        symbol: result?.symbol || address,
        name: result?.name || address,
        address,
        metadata: result
      });

      onClose();
    } finally {
      setLoadingAddress(false);
    }
  };

  const togglePinned = (address) => {
    setPinned((previous) => {
      const exists = previous.some(
        (token) => token.address === address
      );

      return exists
        ? previous.filter(
            (token) => token.address !== address
          )
        : [
            ...previous,
            PINNED_TOKENS.find(
              (token) => token.address === address
            )
          ].filter(Boolean);
    });
  };

  return (
    <div
      className="swap-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="swap-token-modal">
        <div className="swap-modal-head">
          <div>
            <strong>{title}</strong>
            <span>Select a token or paste a contract</span>
          </div>

          <button
            type="button"
            className="swap-modal-close"
            onClick={onClose}
          >
            Ã—
          </button>
        </div>

        <div className="swap-token-search">
          <span>âŒ•</span>
          <input
            autoFocus
            value={query}
            onChange={(event) =>
              setQuery(event.target.value)
            }
            placeholder="Search name or paste addressâ€¦"
          />
        </div>

        <div className="swap-pinned-head">
          <span>PINNED</span>
          <button
            type="button"
            onClick={() => {
              const next = window.prompt(
                'Enter comma-separated pinned symbols',
                pinned.map((token) => token.symbol).join(', ')
              );

              if (!next) return;

              const wanted = next
                .split(',')
                .map((value) => value.trim().toUpperCase())
                .filter(Boolean);

              setPinned(
                PINNED_TOKENS.filter((token) =>
                  wanted.includes(token.symbol)
                )
              );
            }}
          >
            CUSTOMIZE
          </button>
        </div>

        {!query && (
          <div className="swap-pinned-grid">
            {pinned.map((token) => (
              <button
                type="button"
                className={
                  selected?.address === token.address
                    ? 'swap-pinned-token active'
                    : 'swap-pinned-token'
                }
                key={token.address}
                onClick={() => choosePinned(token)}
              >
                <SwapTokenIcon
                  token={{
                    ...token,
                    metadata: metadata[token.address]
                  }}
                />
                <span>
                  <strong>{token.symbol}</strong>
                  <small>
                    {metadata[token.address]?.name ||
                      token.name}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="swap-token-list-head">
          <span>{query ? 'SEARCH RESULTS' : 'TOKENS'}</span>
          
        </div>

        <div className="swap-token-list">
          {filtered.map((token) => (
            <button
              type="button"
              className="swap-token-row"
              key={`row-${token.address}`}
              onClick={() => choosePinned(token)}
            >
              <SwapTokenIcon
                token={{
                  ...token,
                  metadata: metadata[token.address]
                }}
              />

              <span className="swap-token-row-main">
                <strong>{token.symbol}</strong>
                <small>
                  {metadata[token.address]?.name ||
                    token.name}
                </small>
              </span>
            </button>
          ))}

          {query && !filtered.length && (
            <button
              type="button"
              className="swap-contract-result"
              onClick={useContract}
              disabled={loadingAddress}
            >
              <span>ï¼‹</span>
              <span>
                <strong>
                  {loadingAddress
                    ? 'READING CONTRACTâ€¦'
                    : 'USE THIS CONTRACT'}
                </strong>
                <small>{query}</small>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function decimalToAtomic(value, decimals) {
  const text = String(value ?? '').trim();

  if (!text || !/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('Invalid amount.');
  }

  const [whole, fraction = ''] = text.split('.');

  const padded = fraction
    .padEnd(decimals, '0')
    .slice(0, decimals);

  return (
    BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt(padded || '0')
  ).toString();
}

async function requestRheaQuote({
  amountIn,
  tokenIn,
  tokenOut,
  slippage
}) {
  const response = await fetch(
    `/rhea-quote?amountIn=${encodeURIComponent(amountIn)}&tokenIn=${encodeURIComponent(tokenIn)}&tokenOut=${encodeURIComponent(tokenOut)}&slippage=${encodeURIComponent(slippage)}`
  );

  const json = await response.json();

  if (!response.ok) {
    throw new Error(
      json?.result_message ||
      'Rhea SmartRouter request failed.'
    );
  }

  if (json?.result_code !== 0) {
    throw new Error(
      json?.result_message ||
      'Rhea SmartRouter returned an error.'
    );
  }

  if (!json?.result_data) {
    throw new Error(
      'Rhea SmartRouter returned no quote.'
    );
  }

  return json.result_data;
}
function formatAtomicAmount(value, decimals, maxFraction = 8) {
  if (value === null || value === undefined) {
    return '—';
  }

  const raw = String(value);

  if (!/^\d+$/.test(raw)) {
    return '—';
  }

  if (decimals === 0) {
    return raw;
  }

  const padded = raw.padStart(decimals + 1, '0');
  const split = padded.length - decimals;

  const whole = padded.slice(0, split);

  const fraction = padded
    .slice(split)
    .replace(/0+$/, '')
    .slice(0, maxFraction);

  return fraction
    ? whole + '.' + fraction
    : whole;
}
function SwapPanel() {
  const [tokenIn, setTokenIn] = useState(
    PINNED_TOKENS[3]
  );
  const [tokenOut, setTokenOut] = useState(
    PINNED_TOKENS[6]
  );
  const [amountIn, setAmountIn] = useState('');
  const [picker, setPicker] = useState(null);
  const [slippage, setSlippage] = useState('0.5');

  const [tokenMetadata, setTokenMetadata] = useState({});

  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [quoteUpdatedAt, setQuoteUpdatedAt] = useState(null);

  useEffect(() => {
    let mounted = true;

    const loadMetadata = async () => {
      const tokens = [
        tokenIn,
        tokenOut
      ];

      const entries = [];

      for (const token of tokens) {
        if (!mounted) {
          return;
        }

        try {
          const result =
            await fetchTokenMetadata(token.address);

          entries.push([
            token.address,
            result
          ]);
        } catch {
          entries.push([
            token.address,
            null
          ]);
        }

        if (mounted) {
          await new Promise((resolve) =>
            setTimeout(resolve, 700)
          );
        }
      }

      if (!mounted) {
        return;
      }

      setTokenMetadata((previous) => ({
        ...previous,
        ...Object.fromEntries(entries)
      }));
    };

    loadMetadata();

    return () => {
      mounted = false;
    };
  }, [
    tokenIn.address,
    tokenOut.address
  ]);

  const selectToken = (side, token) => {
    const next = {
      ...token,
      metadata:
        token.metadata ||
        tokenMetadata[token.address] ||
        null
    };

    if (side === 'in') {
      setTokenIn(next);
    } else {
      setTokenOut(next);
    }
  };

  const flipTokens = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
  };

  const inMetadata =
    tokenMetadata[tokenIn.address] ||
    tokenIn.metadata ||
    null;

  const outMetadata =
    tokenMetadata[tokenOut.address] ||
    tokenOut.metadata ||
    null;

  useEffect(() => {
    setQuote(null);
    setQuoteError('');
    setQuoteUpdatedAt(null);

    if (!amountIn || Number(amountIn) <= 0) {
      return;
    }

    if (
      inMetadata?.decimals === undefined ||
      outMetadata?.decimals === undefined
    ) {
      return;
    }

    if (tokenIn.address === tokenOut.address) {
      setQuoteError(
        'Input and output tokens must be different.'
      );
      return;
    }

    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        setQuoteLoading(true);

        const atomicAmount = decimalToAtomic(
          amountIn,
          Number(inMetadata.decimals)
        );

        const result = await requestRheaQuote({
          amountIn: atomicAmount,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          slippage: Number(slippage) / 100
        });

        if (cancelled) {
          return;
        }

        setQuote(result);
        setQuoteUpdatedAt(Date.now());
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error(
          '[KINU] SmartRouter quote failed',
          error
        );

        setQuoteError(
          error?.message ||
          'Could not get Rhea SmartRouter quote.'
        );
      } finally {
        if (!cancelled) {
          setQuoteLoading(false);
        }
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    amountIn,
    tokenIn.address,
    tokenOut.address,
    slippage,
    inMetadata?.decimals,
    outMetadata?.decimals
  ]);

  return (
    <section className="swap-shell">
      <div className="swap-intro">
        <div className="eyebrow">
          RHEA Â· AGGREGATED DEX
        </div>

        <h2>
          Swap on
          <br />
          <em>NEAR.</em>
        </h2>

        <p>
          Jupiter-style swap interface,
          powered by Rhea SmartRouter.
          Token selection is built for
          contract search, pinned assets,
          and wallet-aware execution.
        </p>

        <div className="swap-route-card">
          <div>
            <span>ROUTER</span>
            <strong>Rhea SmartRouter</strong>
          </div>

          <div>
            <span>NETWORK</span>
            <strong>NEAR MAINNET</strong>
          </div>

          <div>
            <span>STATUS</span>
            <strong className="swap-live">
              â— QUOTE READY
            </strong>
          </div>
        </div>
      </div>

      <div className="swap-card">
        <div className="swap-card-head">
          <div>
            <strong>Swap</strong>
            <span>Market</span>
          </div>

          <button
            type="button"
            className="swap-settings"
            title="Swap settings"
          >
            âš™
          </button>
        </div>

        <div className="swap-input-block">
          <div className="swap-input-top">
            <span>SELL</span>
            <button type="button">
              BALANCE â€”
            </button>
          </div>

          <div className="swap-input-row">
            <input
              inputMode="decimal"
              value={amountIn}
              onChange={(event) =>
                setAmountIn(event.target.value)
              }
              placeholder="0"
            />

            <button
              type="button"
              className="swap-token-button"
              onClick={() => setPicker('in')}
            >
              <SwapTokenIcon
                token={{
                  ...tokenIn,
                  metadata: inMetadata
                }}
              />

              <span>
                <strong>{tokenIn.symbol}</strong>
                <small>
                  {inMetadata?.name ||
                    tokenIn.name}
                </small>
              </span>

              <b>âŒ„</b>
            </button>
          </div>
        </div>

        <button
          type="button"
          className="swap-flip"
          onClick={flipTokens}
          aria-label="Switch tokens"
        >
          â†•
        </button>

        <div className="swap-input-block">
          <div className="swap-input-top">
            <span>BUY</span>
            <button type="button">
              BALANCE â€”
            </button>
          </div>

          <div className="swap-input-row">
            <input
              disabled
              value={
                quote
                  ? formatAtomicAmount(
                      quote.amount_out,
                      Number(outMetadata?.decimals || 0)
                    )
                  : ''
              }
              placeholder={
                quoteLoading
                  ? 'Fetching...'
                  : '0'
              }
            />

            <button
              type="button"
              className="swap-token-button"
              onClick={() => setPicker('out')}
            >
              <SwapTokenIcon
                token={{
                  ...tokenOut,
                  metadata: outMetadata
                }}
              />

              <span>
                <strong>{tokenOut.symbol}</strong>
                <small>
                  {outMetadata?.name ||
                    tokenOut.name}
                </small>
              </span>

              <b>âŒ„</b>
            </button>
          </div>
        </div>

        <div className="swap-quote-row">
          <span>Slippage</span>

          <div>
            {['0.5', '1', '2'].map((value) => (
              <button
                type="button"
                key={value}
                className={
                  slippage === value
                    ? 'active'
                    : ''
                }
                onClick={() =>
                  setSlippage(value)
                }
              >
                {value}%
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="swap-submit"
          disabled={!amountIn || quoteLoading}
        >
          {!amountIn
            ? 'ENTER AN AMOUNT'
            : quoteLoading
              ? 'FETCHING QUOTE...'
              : quoteError
                ? 'QUOTE FAILED'
                : quote
                  ? 'QUOTE UPDATED'
                  : 'GET QUOTE'}
        </button>

        {quote && !quoteLoading && (
          <div className="swap-result">
            <div className="swap-result-row">
              <span>Minimum received</span>
              <strong>
                {formatAtomicAmount(
                  quote.min_amount_out,
                  Number(outMetadata?.decimals || 0)
                )}{' '}
                {tokenOut.symbol}
              </strong>
            </div>

            <div className="swap-result-row">
              <span>Route</span>
              <strong>
                {Array.isArray(quote.dexs)
                  ? quote.dexs.join(' → ')
                  : 'Rhea SmartRouter'}
              </strong>
            </div>
          </div>
        )}

        {quote && !quoteLoading && (
          <div className="swap-result">
            <div className="swap-result-row">
              <span>Minimum received</span>
              <strong>
                {formatAtomicAmount(
                  quote.min_amount_out,
                  Number(outMetadata?.decimals || 0)
                )}{' '}
                {tokenOut.symbol}
              </strong>
            </div>

            <div className="swap-result-row">
              <span>Route</span>
              <strong>
                {Array.isArray(quote.dexs)
                  ? quote.dexs.join(' → ')
                  : 'Rhea SmartRouter'}
              </strong>
            </div>
          </div>
        )}

        <div className="swap-disclaimer">
          Quote first. No transaction is sent
          from this preview.
        </div>
      </div>

      {picker && (
        <SwapTokenPicker
          title={
            picker === 'in'
              ? 'Select token to sell'
              : 'Select token to buy'
          }
          selected={
            picker === 'in'
              ? tokenIn
              : tokenOut
          }
          onSelect={(token) =>
            selectToken(picker, token)
          }
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}



/* =========================================================
   POOL EXPLORER
   ========================================================= */

function PopularTokens() {
  const tokens = [
    {
      symbol: 'KINU',
      name: 'KINU',
      address: 'kinu.nearlytrade.near'
    },
    {
      symbol: 'NINU',
      name: 'NINU',
      address: 'ninu-4.nearlytrade.near'
    },
    {
      symbol: 'RHEA',
      name: 'RHEA',
      address: 'token.rhealab.near'
    },
    {
      symbol: 'NEAR',
      name: 'NEAR',
      address: 'wrap.near'
    },
    {
      symbol: 'NEARLY',
      name: 'NEARLY',
      address: 'nearly-993927.nearlytrade.near'
    },
    {
      symbol: 'USDC',
      name: 'USD Coin',
      address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
    },
    {
      symbol: 'USDT',
      name: 'Tether USD',
      address: 'usdt.tether-token.near'
    }
  ];

  return (
    <aside className="popular-tokens-panel">
      <div className="popular-tokens-head">
        <div>
          <div className="eyebrow">DISCOVER</div>
          <h2>Popular Tokens</h2>
        </div>

        <span className="live-dot">LIVE</span>
      </div>

      <div className="popular-token-list">
        {tokens.map((token, index) => (
          <div
            className={`popular-token-row ${index === 0 ? 'featured' : ''}`}
            key={token.address}
          >
            <span className="popular-token-icon">
              {token.symbol.slice(0, 1)}
            </span>

            <div className="popular-token-copy">
              <strong>{token.symbol}</strong>
              <small>{token.name}</small>
            </div>

            <span className="popular-token-arrow">
              →
            </span>
          </div>
        ))}
      </div>

      <div className="popular-tokens-footer">
        <span>NEAR MAINNET</span>
        <span>7 TOKENS</span>
      </div>
    </aside>
  );
}
function PoolExplorer() {

  const [pools, setPools] =
    useState([]);

  const [filter, setFilter] =
    useState('ALL');

  const [search, setSearch] =
    useState('');

  const [sort, setSort] =
    useState('ID');

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState('');

  const [selectedPool, setSelectedPool] =
    useState(null);

  const [tokenMetadata, setTokenMetadata] =
    useState({});

  const [metadataLoading, setMetadataLoading] =
    useState(false);

  const [metadataError, setMetadataError] =
    useState('');


  /* =======================================================
     LOAD POOLS
     ======================================================= */

  const loadPools = async () => {

    setLoading(true);
    setError('');

    try {

      const data =
        await fetchRheaPools();

      setPools(data);

    } catch (e) {

      setError(
        e?.message ||
        'Could not load Rhea pools.'
      );

    } finally {

      setLoading(false);

    }
  };


  /* =======================================================
     LOAD TOKEN METADATA
     ======================================================= */

  const loadTokenMetadata = async (
    pool
  ) => {

    if (
      !pool?.tokenIds?.length
    ) {
      return;
    }

    setMetadataLoading(true);
    setMetadataError('');

    try {

      const uniqueTokens = [
        ...new Set(pool.tokenIds)
      ];

      const results =
        await Promise.all(
          uniqueTokens.map(
            async (tokenContract) => {

              try {

                const metadata =
                  await fetchTokenMetadata(
                    tokenContract
                  );

                return {
                  tokenContract,
                  metadata
                };

              } catch (error) {

                return {
                  tokenContract,
                  metadata: {
                    error:
                      error?.message ||
                      'Metadata unavailable'
                  }
                };

              }

            }
          )
        );


      const nextMetadata = {};


      for (
        const result of results
      ) {

        nextMetadata[
          result.tokenContract
        ] = result.metadata;

      }


      setTokenMetadata(
        (previous) => ({
          ...previous,
          ...nextMetadata
        })
      );

    } catch (error) {

      setMetadataError(
        error?.message ||
        'Could not load token metadata.'
      );

    } finally {

      setMetadataLoading(false);

    }
  };


  /* =======================================================
     INITIAL LOAD
     ======================================================= */

  useEffect(() => {

    loadPools();

  }, []);


  /* =======================================================
     FILTER / SEARCH / SORT
     ======================================================= */

  const filtered =
    useMemo(() => {

      const q =
        search
          .trim()
          .toLowerCase();


      const rows =
        pools.filter((pool) => {

          const typeMatch =
            filter === 'ALL' ||
            pool.type === filter;


          const searchMatch =
            !q ||
            pool.tokenIds.some(
              (id) =>
                id
                  .toLowerCase()
                  .includes(q)
            ) ||
            String(pool.poolId)
              .includes(q);


          return (
            typeMatch &&
            searchMatch
          );

        });


      return [...rows].sort(
        (a, b) => {

          if (sort === 'FEE') {

            return (
              (a.fee ?? 999999) -
              (b.fee ?? 999999)
            );

          }

          return a.poolId - b.poolId;

        }
      );

    }, [
      pools,
      filter,
      search,
      sort
    ]);


  /* =======================================================
     COUNTS
     ======================================================= */

  const counts =
  useMemo(() => ({

    all: pools.length,

    amm:
      pools.filter(
        (p) =>
          p.type === 'AMM'
      ).length,

    stable:
      pools.filter(
        (p) =>
          p.type === 'STABLE'
      ).length,

    rated:
      pools.filter(
        (p) =>
          p.type === 'RATED'
      ).length,

    degen:
      pools.filter(
        (p) =>
          p.type === 'DEGEN'
      ).length

  }), [pools]);


  /* =======================================================
     OPEN POOL
     ======================================================= */

  const openPool = async (
    pool
  ) => {

    setSelectedPool(pool);

    await loadTokenMetadata(pool);

  };


  /* =======================================================
     POOL DETAIL
     ======================================================= */

  if (selectedPool) {

    const tokens =
      selectedPool.tokenIds || [];

    const supplies =
      selectedPool.amounts || [];


    /* -----------------------------------------------------
       TOKEN METADATA
       ----------------------------------------------------- */

    const tokenA =
      tokenMetadata[tokens[0]];

    const tokenB =
      tokenMetadata[tokens[1]];


    /* -----------------------------------------------------
       SPOT PRICE
       ----------------------------------------------------- */

    const isAMM =
      selectedPool.type === 'AMM' ||
      selectedPool.kind === 'SIMPLE_POOL';


    const spotPrice =
      isAMM
        ? calculateSpotPrice(
            supplies[0],
            tokenA?.decimals,
            supplies[1],
            tokenB?.decimals
          )
        : null;


    const reverseSpotPrice =
      spotPrice !== null &&
      spotPrice !== 0
        ? 1 / spotPrice
        : null;


    return (

      <section
        className="
          pools-panel
          pool-detail-panel
        "
      >

        {/* =================================================
            HEADER
            ================================================= */}

        <div className="panel-head">

          <div>

            <button
              className="back-button"
              onClick={() => {

                setSelectedPool(null);
                setMetadataError('');

              }}
            >
              â† BACK TO POOLS
            </button>


            <div className="eyebrow">
              RHEA Â· NEAR MAINNET
            </div>


            <h2>
              Pool{' '}
              {formatPoolId(
                selectedPool.poolId
              )}
            </h2>


            <p>
              Live pool state read from
              the Rhea NEAR contract.
            </p>

          </div>


          <div className="detail-type">

            <span className="type-pill">
              {selectedPool.type}
            </span>

            <strong>
              {formatFee(
                selectedPool.fee
              )}
            </strong>

          </div>

        </div>


        {/* =================================================
            METADATA ERROR
            ================================================= */}

        {metadataError && (

          <div className="inline-error">
            Token metadata:{' '}
            {metadataError}
          </div>

        )}


        {/* =================================================
            TOKEN PAIR
            ================================================= */}

        <div className="pool-pair-hero">

          <TokenDisplay
            tokenId={tokens[0]}
            metadata={tokenA}
            label="TOKEN A"
          />


          <div className="pool-pair-divider">
            /
          </div>


          <TokenDisplay
            tokenId={tokens[1]}
            metadata={tokenB}
            label="TOKEN B"
          />

        </div>


        {/* =================================================
            SUMMARY
            ================================================= */}

        <div className="detail-grid">

          {/* POOL TYPE */}

          <div className="detail-card">

            <small>
              POOL TYPE
            </small>

            <strong>
              {selectedPool.type}
            </strong>

            <span>
              {selectedPool.kind}
            </span>

          </div>


          {/* FEE */}

          <div className="detail-card">

            <small>
              FEE
            </small>

            <strong>
              {formatFee(
                selectedPool.fee
              )}
            </strong>

            <span>
              On-chain pool fee
            </span>

          </div>


          {/* SHARE SUPPLY */}

          <div className="detail-card">

            <small>
              SHARE SUPPLY
            </small>

            <strong className="mono">

              {selectedPool.sharesTotalSupply ??
                'â€”'}

            </strong>

            <span>
              Raw on-chain value
            </span>

          </div>


          {/* POOL INDEX */}

          <div className="detail-card">

            <small>
              POOL INDEX
            </small>

            <strong>
              #{selectedPool.poolId}
            </strong>

            <span>
              Local get_pools() index
            </span>

          </div>


          {/* SPOT PRICE */}

          <div className="detail-card spot-price-card">

            <small>
              SPOT PRICE
            </small>

            <strong>

              {spotPrice === null

                ? 'â€”'

                : `1 ${
                    tokenA?.symbol ||
                    tokens[0] ||
                    'TOKEN A'
                  } â‰ˆ ${
                    formatSpotPrice(
                      spotPrice
                    )
                  } ${
                    tokenB?.symbol ||
                    tokens[1] ||
                    'TOKEN B'
                  }`}

            </strong>


            <span>

              {reverseSpotPrice === null

                ? 'Reserve ratio Â· AMM'

                : `1 ${
                    tokenB?.symbol ||
                    tokens[1] ||
                    'TOKEN B'
                  } â‰ˆ ${
                    formatSpotPrice(
                      reverseSpotPrice
                    )
                  } ${
                    tokenA?.symbol ||
                    tokens[0] ||
                    'TOKEN A'
                  }`}

            </span>

          </div>

        </div>


        {/* =================================================
            LIQUIDITY
            ================================================= */}

        <div className="detail-section">

          <div className="detail-section-head">

            <div>

              <div className="eyebrow">
                LIQUIDITY
              </div>

              <h3>
                Pool Reserves
              </h3>

            </div>


            <span className="onchain-badge">

              {metadataLoading
                ? 'LOADING'
                : 'ON-CHAIN'}

            </span>

          </div>


          <div className="reserve-grid">

            {/* TOKEN A */}

            <div className="reserve-card">

              <small>
                TOKEN A
              </small>

              <div className="reserve-token">

                {tokenA?.icon ? (
                  <img
                    src={tokenA.icon}
                    alt=""
                    className="token-icon"
                  />
                ) : (
                  <span className="token-icon token-icon-fallback">
                    {(tokenA?.symbol ||
                      tokens[0] ||
                      'â€”')
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                )}

                <div>

                  <strong>
                    {tokenA?.symbol ||
                      tokens[0] ||
                      'â€”'}
                  </strong>

                  {tokenA?.name &&
                    tokenA.name !== tokenA.symbol && (
                      <span className="token-name">
                        {tokenA.name}
                      </span>
                    )}

                </div>

              </div>

              <code>
                {metadataLoading
                  ? 'Loading metadataâ€¦'
                  : formatTokenAmount(
                      supplies[0],
                      tokenA?.decimals
                    )}
              </code>

            </div>


            {/* TOKEN B */}

            <div className="reserve-card">

              <small>
                TOKEN B
              </small>

              <div className="reserve-token">

                {tokenB?.icon ? (
                  <img
                    src={tokenB.icon}
                    alt=""
                    className="token-icon"
                  />
                ) : (
                  <span className="token-icon token-icon-fallback">
                    {(tokenB?.symbol ||
                      tokens[1] ||
                      'â€”')
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                )}

                <div>

                  <strong>
                    {tokenB?.symbol ||
                      tokens[1] ||
                      'â€”'}
                  </strong>

                  {tokenB?.name &&
                    tokenB.name !== tokenB.symbol && (
                      <span className="token-name">
                        {tokenB.name}
                      </span>
                    )}

                </div>

              </div>

              <code>
                {metadataLoading
                  ? 'Loading metadataâ€¦'
                  : formatTokenAmount(
                      supplies[1],
                      tokenB?.decimals
                    )}
              </code>

            </div>

          </div>

        </div>


        {/* =================================================
            CONTRACT
            ================================================= */}

        <div className="detail-section">

          <div className="detail-section-head">

            <div>

              <div className="eyebrow">
                CONTRACT
              </div>

              <h3>
                Pool Information
              </h3>

            </div>

          </div>


          <div className="info-list">

            {/* CONTRACT */}

            <div>

              <span>
                Contract
              </span>

              <code>
                v2.ref-finance.near
              </code>

            </div>


            {/* METHOD */}

            <div>

              <span>
                Method
              </span>

              <code>
                get_pools
              </code>

            </div>


            {/* FINALITY */}

            <div>

              <span>
                Finality
              </span>

              <code>
                final
              </code>

            </div>


            {/* TOKEN DECIMALS */}

            <div>

              <span>
                Token decimals
              </span>

              <code>

                {tokens.map(
                  (token, index) => (

                    <React.Fragment
                      key={token}
                    >

                      {index > 0
                        ? ' Â· '
                        : ''}

                      {tokenMetadata[token]
                        ?.symbol ||
                        token}

                      {' '}

                      {tokenMetadata[token]
                        ?.decimals ??
                        'â€”'}

                    </React.Fragment>

                  )
                )}

              </code>

            </div>


            {/* POOL KIND */}

            <div>

              <span>
                Pool kind
              </span>

              <code>
                {selectedPool.kind}
              </code>

            </div>

          </div>

        </div>


        {/* =================================================
            SOURCE
            ================================================= */}

        <div className="source-note">

          SOURCE Â·{' '}

          <code>
            v2.ref-finance.near
          </code>

          {' Â· '}

          <code>
            get_pools
          </code>

          {' Â· '}

          finality: final

        </div>

      </section>

    );
  }


  /* =======================================================
     POOL EXPLORER
     ======================================================= */

  return (

    <section className="pools-panel">

      {/* =================================================
          HEADER
          ================================================= */}

      <div className="panel-head">

        <div>

          <div className="eyebrow">
            RHEA Â· NEAR MAINNET
          </div>


          <h2>
            Pool Explorer
          </h2>


          <p>
            Live pool state from the
            Rhea NEAR contract.
            No hard-coded pool numbers.
          </p>

        </div>


        <button
          className="ghost"
          onClick={loadPools}
          disabled={loading}
        >

          {loading
            ? 'REFRESHINGâ€¦'
            : 'â†» REFRESH'}

        </button>

      </div>


      {/* =================================================
          TOOLBAR
          ================================================= */}

      <div className="pool-toolbar">

        <div className="filters">

  {[
    [
      'ALL',
      `ALL ${counts.all}`
    ],

    [
      'AMM',
      `AMM ${counts.amm}`
    ],

    [
      'STABLE',
      `STABLE ${counts.stable}`
    ],

    [
      'RATED',
      `RATED ${counts.rated}`
    ],

    [
      'DEGEN',
      `DEGEN ${counts.degen}`
    ]

  ].map(
    ([key, label]) => (

      <button
        key={key}
        className={
          filter === key
            ? 'active'
            : ''
        }
        onClick={() =>
          setFilter(key)
        }
      >
        {label}
      </button>

    )
  )}

</div>


        <input
          value={search}
          onChange={(e) =>
            setSearch(e.target.value)
          }
          placeholder="Search token or pool IDâ€¦"
        />


        <select
          value={sort}
          onChange={(e) =>
            setSort(e.target.value)
          }
        >

          <option value="ID">
            POOL ID
          </option>

          <option value="FEE">
            FEE
          </option>

        </select>

      </div>


      {/* =================================================
          ERROR
          ================================================= */}

      {error && (

        <div className="inline-error">
          {error}
        </div>

      )}


      {/* =================================================
          TABLE
          ================================================= */}

      <div className="pool-table-wrap">

        <table className="pool-table">

          <thead>

            <tr>

              <th>
                POOL
              </th>

              <th>
                TYPE
              </th>

              <th>
                TOKENS
              </th>

              <th>
                FEE
              </th>

              <th>
                SUPPLY STATE
              </th>

              <th>
                ACTION
              </th>

            </tr>

          </thead>


          <tbody>

            {!loading &&
              filtered.map(
                (pool) => (

                  <tr
                    key={
                      `${pool.kind}-${pool.poolId}`
                    }
                    className="pool-row"
                    onClick={() =>
                      openPool(pool)
                    }
                  >

                    <td>

                      <strong>
  {formatPoolId(
    pool.poolId
  )}
</strong>

                      <small>
                        {pool.kind}
                      </small>

                    </td>


                    <td>

                      <span className="type-pill">
                        {pool.type}
                      </span>

                    </td>


                    <td>

                      <div className="token-pair">

                        {pool.tokenIds.map(
                          (
                            token,
                            index
                          ) => (

                            <span
                              key={
                                `${token}-${index}`
                              }
                            >
                              {token}
                            </span>

                          )
                        )}

                      </div>

                    </td>


                    <td>
                      {formatFee(
                        pool.fee
                      )}
                    </td>


                    <td className="muted">

                      {pool.amounts
                        ? 'ON-CHAIN'
                        : 'â€”'}

                    </td>


                    <td>

                      <button
                        className="pool-open-button"
                        onClick={(event) => {

                          event.stopPropagation();

                          openPool(pool);

                        }}
                      >
                        VIEW â†’
                      </button>

                    </td>

                  </tr>

                )
              )}


            {!loading &&
              filtered.length === 0 && (

                <tr>

                  <td
                    colSpan="6"
                    className="empty"
                  >

                    {error
                      ? 'Unable to read pools.'
                      : 'No pools match this filter.'}

                  </td>

                </tr>

              )}


            {loading && (

              <tr>

                <td
                  colSpan="6"
                  className="empty"
                >
                  Reading Rhea pools
                  from NEARâ€¦
                </td>

              </tr>

            )}

          </tbody>

        </table>

      </div>


      {/* =================================================
          SOURCE
          ================================================= */}

      <div className="source-note">

        SOURCE Â·{' '}

        <code>
          v2.ref-finance.near
        </code>

        {' Â· '}

        <code>
          get_pools
        </code>

        {' Â· '}

        finality: final

      </div>

    </section>

  );
}


/* =========================================================
   APP
   ========================================================= */

function App() {

  const [account, setAccount] =
    useState(null);

  const [balance, setBalance] =
    useState(null);

  const [ready, setReady] =
    useState(false);

  const [busy, setBusy] =
    useState(false);

  const [error, setError] =
    useState('');


  /* =======================================================
     METEOR WALLET
     ======================================================= */

  useEffect(() => {

    let mounted = true;


    initMeteorWallet(

      async (id) => {

        if (!mounted) {
          return;
        }


        setAccount(id);


        if (!id) {

          setBalance(null);

          return;

        }


        try {

          const amount =
            await getNearAccountBalance(id);

          if (mounted) {
            setBalance(amount);
          }

        } catch (e) {

          if (mounted) {

            setError(
              e?.message ||
              'Could not read NEAR balance.'
            );

          }

        }

      },


      (err) => {

        if (mounted) {

          setError(
            err?.message ||
            'Meteor Wallet initialization failed.'
          );

        }

      }

    ).then((selector) => {

      if (mounted) {

        setReady(
          Boolean(selector)
        );

      }

    });


    return () => {

      mounted = false;

      destroyMeteor();

    };

  }, []);


  /* =======================================================
     CONNECT / DISCONNECT
     ======================================================= */

  const connect = async () => {

    setError('');
    setBusy(true);

    try {

      if (account) {

        await disconnectMeteor();

      } else {

        await connectWallet();

      }

    } catch (e) {

      setError(
        e?.message ||
        'Wallet connection failed.'
      );

    } finally {

      setBusy(false);

    }

  };


  /* =======================================================
     UI
     ======================================================= */

  return (

    <div className="page">

      {/* =================================================
          TOP BAR
          ================================================= */}

      <header className="topbar">

        <div className="brand">

          <span className="dog">
            ðŸ•
          </span>

          <div>

            <strong>
              KINU
            </strong>

            <small>
              RHEA TERMINAL
            </small>

          </div>

        </div>


        <div className="network">

          <i></i>

          NEAR MAINNET

        </div>


        <button
          className="connect"
          onClick={connect}
          disabled={!ready || busy}
        >

          {!ready

            ? 'INITIALIZINGâ€¦'

            : busy

              ? (
                account
                  ? 'DISCONNECTING...'
                  : 'OPENING WALLET...'
              )

              : account

                ? shortAddress(account)

                : 'CONNECT WALLET'}

        </button>

      </header>


      {/* =================================================
          ERROR
          ================================================= */}

      {error && (

        <div className="error">

          <b>
            NOTICE
          </b>

          <span>
            {error}
          </span>

          <button
            onClick={() =>
              setError('')
            }
          >
            Ã—
          </button>

        </div>

      )}


      <main>

        {/* =================================================
            HERO
            ================================================= */}

        <section className="hero compact">

          <div className="eyebrow">
            KINU Â· RHEA Â· NEAR LIQUIDITY
          </div>


          <h1>
            Every pool.
            <br />

            <em>
              One terminal.
            </em>

          </h1>


          <p>
            Explore Rhea liquidity on
            NEAR with a custom interface.
            Meteor remains the only
            wallet connection path.
          </p>


          <div className="status">

            <span
              className={
                ready ? 'ok' : ''
              }
            ></span>


            {ready

              ? 'Wallet Selector ready Â· Rhea data layer online'

              : 'Loading wallet selector'}

          </div>

        </section>


        {/* =================================================
            WALLET
            ================================================= */}

        <section className="wallet-strip">

          <div>

            <small>
              WALLET
            </small>

            <strong>

              {account
                ? shortAddress(account)
                : 'NOT CONNECTED'}

            </strong>

          </div>


          <div>

            <small>
              NEAR BALANCE
            </small>

            <strong>

              {balance === null

                ? 'â€”'

                : `${formatNear(balance)} NEAR`}

            </strong>

          </div>


          <div>

            <small>
              NETWORK
            </small>

            <strong>
              MAINNET
            </strong>

          </div>

        </section>


        {/* =================================================
            RHEA
            ================================================= */}

        <div className="terminal-grid">

  <PopularTokens />

  <section className="featured-pools-column">
    <div className="featured-pools-label">
      <div>
        <span className="eyebrow">RHEA · NEAR</span>
        <h2>Featured Pools</h2>
        <p>
          Live liquidity from the Rhea NEAR contract.
        </p>
      </div>
    </div>

    <PoolExplorer />
  </section>

  <aside className="swap-column">
    <div className="swap-column-label">
      <span className="eyebrow">TRADE</span>
      <h2>Swap</h2>
      <p>Best available route through Rhea.</p>
    </div>

    <SwapPanel />
  </aside>

</div>


        {/* =================================================
            ROADMAP
            ================================================= */}

        <section className="roadmap">

          <div>

            <small>
              01 Â· LIVE
            </small>

            <h3>
              Meteor wallet
            </h3>

            <p>
              Connect Â· account detection Â·
              NEAR balance
            </p>

          </div>


          <div>

            <small>
              02 Â· LIVE
            </small>

            <h3>
              Rhea pools
            </h3>

            <p>
              AMM + Stable + Rated + Degen
              pool discovery from NEAR
            </p>

          </div>


          <div className="dim">

            <small>
              03 Â· NEXT
            </small>

            <h3>
              ALMM / CLMM
            </h3>

            <p>
              Dedicated Rhea V2 pool
              data layer
            </p>

          </div>


          <div className="dim">

            <small>
              04 Â· NEXT
            </small>

            <h3>
              Swap + LP
            </h3>

            <p>
              Quotes Â· transaction builder Â·
              Meteor signing
            </p>

          </div>

        </section>

      </main>


      {/* =================================================
          FOOTER
          ================================================= */}

      <footer>

        <span>
          ðŸ¾ TWO DOGS. ONE NEAR.
        </span>

        <span>
          KINU RHEA TERMINAL Â· METEOR
        </span>

      </footer>

    </div>

  );
}


/* =========================================================
   MOUNT REACT
   ========================================================= */

createRoot(
  document.getElementById('root')
).render(
  <App />
);
















