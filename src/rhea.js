const RPC_URL = '/near-rpc';

export const RHEA_CONTRACT = 'v2.ref-finance.near';

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'kinu-rhea',
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`NEAR RPC HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      json.error.data ||
      json.error.message ||
      'NEAR RPC error'
    );
  }

  return json.result;
}

function encodeArgs(args) {
  return btoa(JSON.stringify(args));
}

async function viewFunction(
  contractId,
  methodName,
  args = {}
) {
  const result = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: encodeArgs(args)
  });

  const bytes = result.result || [];

  const text = new TextDecoder().decode(
    new Uint8Array(bytes)
  );

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

/**
 * Return the number of pools currently stored
 * by the Rhea contract.
 */
export async function getRheaPoolCount() {
  const result = await viewFunction(
    RHEA_CONTRACT,
    'get_number_of_pools'
  );

  const value =
    result?.number_of_pools ??
    result?.total_pools ??
    result;

  if (value === null || value === undefined) {
    throw new Error(
      'Rhea did not return a pool count.'
    );
  }

  return Number(value);
}

/**
 * Convert Rhea pool kind into UI-friendly type.
 */
export function poolKindLabel(kind) {
  switch (kind) {
    case 'SIMPLE_POOL':
      return 'AMM';

    case 'STABLE_SWAP':
      return 'STABLE';

    case 'RATED_SWAP':
      return 'RATED';

    case 'DEGEN_SWAP':
      return 'DEGEN';

    default:
      return kind || 'UNKNOWN';
  }
}

/**
 * A pool is considered non-zero when:
 * - shares_total_supply !== "0"
 * - every reserve amount !== "0"
 *
 * This deliberately uses strings.
 * NEAR integer values can be larger than JS Number
 * or .NET Decimal limits.
 */
export function isNonZeroPool(pool) {
  if (!pool) {
    return false;
  }

  if (
    pool.shares_total_supply === null ||
    pool.shares_total_supply === undefined ||
    pool.shares_total_supply === '0'
  ) {
    return false;
  }

  if (!Array.isArray(pool.amounts)) {
    return false;
  }

  return pool.amounts.length > 0 &&
    pool.amounts.every(
      (amount) =>
        amount !== null &&
        amount !== undefined &&
        String(amount) !== '0'
    );
}

/**
 * Normalize one raw Rhea pool.
 *
 * IMPORTANT:
 * poolId is derived from the absolute index used
 * by get_pools(from_index, limit).
 */
function normalizePool(
  pool,
  poolId
) {
  const tokenIds =
    Array.isArray(pool?.token_account_ids)
      ? pool.token_account_ids
      : [];

  const amounts =
    Array.isArray(pool?.amounts)
      ? pool.amounts.map(String)
      : [];

  const kind =
    pool?.pool_kind ??
    'UNKNOWN';

  return {
    poolId,

    kind,

    type: poolKindLabel(kind),

    tokenIds,

    amounts,

    fee: pool?.total_fee ?? null,

    sharesTotalSupply:
      pool?.shares_total_supply !== undefined &&
      pool?.shares_total_supply !== null
        ? String(pool.shares_total_supply)
        : null,

    amp:
      pool?.amp !== undefined &&
      pool?.amp !== null
        ? String(pool.amp)
        : null,

    nonZero: isNonZeroPool(pool),

    raw: pool
  };
}

/**
 * Fetch one page of pools.
 */
export async function fetchRheaPoolPage({
  fromIndex = 0,
  limit = DEFAULT_PAGE_SIZE
} = {}) {
  const batch = await viewFunction(
    RHEA_CONTRACT,
    'get_pools',
    {
      from_index: fromIndex,
      limit
    }
  );

  if (!Array.isArray(batch)) {
    throw new Error(
      `Unexpected Rhea get_pools response at index ${fromIndex}.`
    );
  }

  return batch.map(
    (pool, index) =>
      normalizePool(
        pool,
        fromIndex + index
      )
  );
}

/**
 * Fetch all Rhea pools.
 *
 * By default the function asks the contract for the
 * current pool count instead of hard-coding 8915.
 */
export async function fetchRheaPools({
  pageSize = DEFAULT_PAGE_SIZE,
  delayMs = DEFAULT_DELAY_MS,
  onlyNonZero = true,
    maxPools = null
  } = {}) {
  const totalPools =
    await getRheaPoolCount();

  if (
    !Number.isFinite(totalPools) ||
    totalPools < 0
  ) {
    throw new Error(
      `Invalid Rhea pool count: ${totalPools}`
    );
  }

  const targetPools =
    Number.isFinite(maxPools) && maxPools > 0
      ? Math.min(
          Math.floor(maxPools),
          totalPools
        )
      : totalPools;

  const pools = [];

  for (
    let fromIndex = 0;
    fromIndex < targetPools;
    fromIndex += pageSize
  ) {
    if (fromIndex > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    const limit = Math.min(
      pageSize,
      targetPools - fromIndex
    );

    const page =
      await fetchRheaPoolPage({
        fromIndex,
        limit
      });

    pools.push(...page);

    if (page.length < limit) {
      break;
    }
  }

  return onlyNonZero
    ? pools.filter(
        (pool) => pool.nonZero
      )
    : pools;
}

/**
 * Return statistics from a fetched pool list.
 */
export function getRheaPoolStats(
  pools
) {
  const stats = {
    total: pools.length,
    nonZero: 0,
    byType: {}
  };

  for (const pool of pools) {
    if (pool.nonZero) {
      stats.nonZero += 1;
    }

    const type =
      pool.type || 'UNKNOWN';

    stats.byType[type] =
      (stats.byType[type] || 0) + 1;
  }

  return stats;
}

/**
 * Find pools containing both tokens.
 *
 * Order-independent.
 */
export function findRheaPoolsByTokens(
  pools,
  tokenA,
  tokenB
) {
  if (!tokenA || !tokenB) {
    return [];
  }

  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();

  return pools.filter(
    (pool) => {
      const tokens =
        pool.tokenIds.map(
          (token) =>
            String(token).toLowerCase()
        );

      return (
        tokens.includes(a) &&
        tokens.includes(b)
      );
    }
  );
}

/**
 * Find pools containing a single token.
 */
export function findRheaPoolsByToken(
  pools,
  token
) {
  if (!token) {
    return [];
  }

  const target =
    token.toLowerCase();

  return pools.filter(
    (pool) =>
      pool.tokenIds.some(
        (tokenId) =>
          String(tokenId).toLowerCase() ===
          target
      )
  );
}

/**
 * Get one pool by its actual poolId.
 */
export function findRheaPoolById(
  pools,
  poolId
) {
  return pools.find(
    (pool) =>
      Number(pool.poolId) ===
      Number(poolId)
  ) ?? null;
}

/**
 * AMM reserve-based spot price.
 *
 * Returns:
 * amountB / amountA
 *
 * where reserves are converted using
 * token decimals.
 */
export function calculateSpotPrice(
  amountA,
  decimalsA,
  amountB,
  decimalsB
) {
  if (
    amountA === null ||
    amountA === undefined ||
    amountB === null ||
    amountB === undefined
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

  const rawA = BigInt(amountA);
  const rawB = BigInt(amountB);

  if (rawA === 0n) {
    return null;
  }

  /*
   * We intentionally avoid Number(rawA)
   * because NEAR token amounts can exceed
   * JavaScript's safe integer range.
   *
   * Convert through decimal strings only
   * after normalizing the token amounts.
   */
  const normalizedA =
    Number(rawA) /
    10 ** Number(decimalsA);

  const normalizedB =
    Number(rawB) /
    10 ** Number(decimalsB);

  if (
    !Number.isFinite(normalizedA) ||
    !Number.isFinite(normalizedB) ||
    normalizedA === 0
  ) {
    return null;
  }

  return normalizedB / normalizedA;
}

export function formatSpotPrice(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return 'â€”';
  }

  if (value === 0) {
    return '0';
  }

  if (value >= 1000) {
    return value.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 4
      }
    );
  }

  if (value >= 1) {
    return value.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 8
      }
    );
  }

  return value.toLocaleString(
    'en-US',
    {
      maximumFractionDigits: 12
    }
  );
}
/**
 * Fetch NEAR fungible token metadata.
 */
export async function fetchTokenMetadata(
  tokenId
) {
  if (!tokenId) {
    return null;
  }

  try {
    const metadata =
      await viewFunction(
        tokenId,
        'ft_metadata'
      );

    return {
      tokenId,
      ...metadata
    };
  } catch (error) {
    console.warn(
      `[KINU] Failed to fetch metadata for ${tokenId}`,
      error
    );

    return {
      tokenId,
      symbol: tokenId,
      name: tokenId,
      decimals: 0,
      icon: null
    };
  }
}
export async function fetchSmartRouterQuote({
  amountIn,
  tokenIn,
  tokenOut,
  slippage = 0.005
}) {
  if (!amountIn) {
    throw new Error('amountIn is required');
  }

  if (!tokenIn) {
    throw new Error('tokenIn is required');
  }

  if (!tokenOut) {
    throw new Error('tokenOut is required');
  }

  const params = new URLSearchParams({
    amountIn: String(amountIn),
    tokenIn: String(tokenIn),
    tokenOut: String(tokenOut),
    slippage: String(slippage)
  });

  const response = await fetch(
    `https://smartx.rhea.finance/swapMultiDexPath?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(
      `SmartRouter HTTP ${response.status}: ${response.statusText}`
    );
  }

  const json = await response.json();

  if (!json) {
    throw new Error('SmartRouter returned an empty response');
  }

  if (json.result_code !== 0) {
    throw new Error(
      json.result_message ||
      `SmartRouter error ${json.result_code}`
    );
  }

  if (!json.result_data) {
    throw new Error('SmartRouter returned no result_data');
  }
  
 return json.result_data;
}








/**
 * Fetch real OHLCV candles from GeckoTerminal
 * for a Rhea Finance pool on NEAR.
 *
 * Returned candle format:
 * {
 *   time,
 *   open,
 *   high,
 *   low,
 *   close,
 *   volume
 * }
 */
export async function fetchRheaOHLCV({
  pairAddress,
  timeframe = '5m',
  limit = 100
} = {}) {
  if (!pairAddress) {
    throw new Error('Rhea OHLCV requires a pair address.');
  }

  const timeframeConfig = {
    '5m': {
      interval: 'minute',
      aggregate: 5
    },
    '15m': {
      interval: 'minute',
      aggregate: 15
    },
    '1h': {
      interval: 'hour',
      aggregate: 1
    },
    '4h': {
      interval: 'hour',
      aggregate: 4
    },
    '1d': {
      interval: 'day',
      aggregate: 1
    }
  };

  const config =
    timeframeConfig[timeframe] ||
    timeframeConfig['5m'];

  const encodedPair =
    encodeURIComponent(pairAddress);

  const response = await fetch(
    `/gecko-ohlcv/api/v2/networks/near/pools/${encodedPair}/ohlcv/${config.interval}?aggregate=${encodeURIComponent(config.aggregate)}&limit=${encodeURIComponent(limit)}`
  );

  if (!response.ok) {
    throw new Error(
      `GeckoTerminal OHLCV HTTP ${response.status}`
    );
  }

  const json = await response.json();

  const list =
    json?.data?.attributes?.ohlcv_list;

  if (!Array.isArray(list)) {
    throw new Error(
      'GeckoTerminal returned no OHLCV data.'
    );
  }

  return list
    .filter(
      (candle) =>
        Array.isArray(candle) &&
        candle.length >= 6
    )
    .map(
      (candle) => ({
        time: Number(candle[0]),
        open: Number(candle[1]),
        high: Number(candle[2]),
        low: Number(candle[3]),
        close: Number(candle[4]),
        volume: Number(candle[5])
      })
    )
    .filter(
      (candle) =>
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close) &&
        Number.isFinite(candle.volume)
    )
    .sort(
      (a, b) => a.time - b.time
    );
}

/**
 * Resolve the best Rhea Finance pair for two NEAR tokens.
 *
 * Uses Dexscreener's real pair registry and selects the
 * Rhea pair with the highest reported USD liquidity.
 */
export async function findRheaDexPair(
  tokenA,
  tokenB
) {
  if (!tokenA || !tokenB) {
    return null;
  }

  const addressA = String(tokenA).toLowerCase();
  const addressB = String(tokenB).toLowerCase();

  const response = await fetch(
    `/dex-pairs/latest/dex/tokens/${encodeURIComponent(addressA)}`
  );

  if (!response.ok) {
    throw new Error(
      `Dexscreener pair lookup HTTP ${response.status}`
    );
  }

  const json = await response.json();

  const pairs = Array.isArray(json?.pairs)
    ? json.pairs
    : [];

  const matches = pairs.filter((pair) => {
    if (pair?.chainId !== 'near') {
      return false;
    }

    if (pair?.dexId !== 'rhea-finance') {
      return false;
    }

    const base =
      String(pair?.baseToken?.address || '')
        .toLowerCase();

    const quote =
      String(pair?.quoteToken?.address || '')
        .toLowerCase();

    return (
      (base === addressA && quote === addressB) ||
      (base === addressB && quote === addressA)
    );
  });

  if (!matches.length) {
    return null;
  }

  matches.sort(
    (a, b) =>
      Number(b?.liquidity?.usd || 0) -
      Number(a?.liquidity?.usd || 0)
  );

  return matches[0];
}



