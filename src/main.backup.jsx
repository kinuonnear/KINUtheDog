import React, {
  useEffect,
  useMemo,
  useState
} from 'react';

import { createRoot } from 'react-dom/client';

import './styles.css';

import {
  initMeteorWallet,
  connectMeteor,
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
    ? `${account.slice(0, 10)}…${account.slice(-8)}`
    : account;
}


function formatNear(yocto) {
  if (!yocto) return '0';

  const n = Number(yocto) / 1e24;

  return Number.isFinite(n)
    ? n.toLocaleString(undefined, {
        maximumFractionDigits: 6
      })
    : '-';
}


function formatPoolId(id) {
  return `#${id}`;
}


function formatFee(fee) {
  if (
    fee === null ||
    fee === undefined
  ) {
    return '-';
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
    return '-';
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
    return '-';
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
    '-';

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
            [Copy] Copy address
          </button>

          <button
            type="button"
            onClick={openExplorer}
          >
            [Link] Block explorer
          </button>

        </div>
      )}

    </div>
  );
}

/* =========================================================
   POOL EXPLORER
   ========================================================= */

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

          return a.id - b.id;

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
              ← BACK TO POOLS
            </button>


            <div className="eyebrow">
              RHEA · NEAR MAINNET
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
                '-'}

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

                ? '-'

                : `1 ${
                    tokenA?.symbol ||
                    tokens[0] ||
                    'TOKEN A'
                  } ≈ ${
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

                ? 'Reserve ratio · AMM'

                : `1 ${
                    tokenB?.symbol ||
                    tokens[1] ||
                    'TOKEN B'
                  } ≈ ${
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


              <strong>
                {tokenA?.symbol ||
                  tokens[0] ||
                  '-'}
              </strong>


              <code>

                {metadataLoading

                  ? 'Loading metadata…'

                  : formatTokenAmount(
                      supplies[0],
                      tokenA?.decimals
                    )}

              </code>


              <span className="token-contract">

                {tokenA?.name ||
                  tokens[0] ||
                  '-'}

              </span>


              <span>
                {tokens[0] || '-'}
              </span>

            </div>


            {/* TOKEN B */}

            <div className="reserve-card">

              <small>
                TOKEN B
              </small>


              <strong>
                {tokenB?.symbol ||
                  tokens[1] ||
                  '-'}
              </strong>


              <code>

                {metadataLoading

                  ? 'Loading metadata…'

                  : formatTokenAmount(
                      supplies[1],
                      tokenB?.decimals
                    )}

              </code>


              <span className="token-contract">

                {tokenB?.name ||
                  tokens[1] ||
                  '-'}

              </span>


              <span>
                {tokens[1] || '-'}
              </span>

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
                        ? ' · '
                        : ''}

                      {tokenMetadata[token]
                        ?.symbol ||
                        token}

                      {' '}

                      {tokenMetadata[token]
                        ?.decimals ??
                        '-'}

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

          SOURCE ·{' '}

          <code>
            v2.ref-finance.near
          </code>

          {' · '}

          <code>
            get_pools
          </code>

          {' · '}

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
            RHEA · NEAR MAINNET
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
            ? 'REFRESHING…'
            : '↻ REFRESH'}

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
          placeholder="Search token or pool ID…"
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
                        : '-'}

                    </td>


                    <td>

                      <button
                        className="pool-open-button"
                        onClick={(event) => {

                          event.stopPropagation();

                          openPool(pool);

                        }}
                      >
                        VIEW →
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
                  from NEAR…
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

        SOURCE ·{' '}

        <code>
          v2.ref-finance.near
        </code>

        {' · '}

        <code>
          get_pools
        </code>

        {' · '}

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

        await connectMeteor();

      }

    } catch (e) {

      setError(
        e?.message ||
        'Meteor Wallet connection failed.'
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
            🐕
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

            ? 'INITIALIZING…'

            : busy

              ? (
                account
                  ? 'DISCONNECTING…'
                  : 'OPENING METEOR…'
              )

              : account

                ? shortAddress(account)

                : 'CONNECT METEOR'}

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
            ×
          </button>

        </div>

      )}


      <main>

        {/* =================================================
            HERO
            ================================================= */}

        <section className="hero compact">

          <div className="eyebrow">
            KINU · RHEA · NEAR LIQUIDITY
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

              ? 'Meteor adapter ready · Rhea data layer online'

              : 'Loading Meteor adapter'}

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

                ? '-'

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

        <PoolExplorer />


        {/* =================================================
            ROADMAP
            ================================================= */}

        <section className="roadmap">

          <div>

            <small>
              01 · LIVE
            </small>

            <h3>
              Meteor wallet
            </h3>

            <p>
              Connect · account detection ·
              NEAR balance
            </p>

          </div>


          <div>

            <small>
              02 · LIVE
            </small>

            <h3>
              Rhea pools
            </h3>

            <p>
              AMM + Stable pool discovery
              from NEAR
            </p>

          </div>


          <div className="dim">

            <small>
              03 · NEXT
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
              04 · NEXT
            </small>

            <h3>
              Swap + LP
            </h3>

            <p>
              Quotes · transaction builder ·
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
          🐾 TWO DOGS. ONE NEAR.
        </span>

        <span>
          KINU RHEA TERMINAL · METEOR
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




