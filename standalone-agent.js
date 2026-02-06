#!/usr/bin/env node
/**
 * Standalone Trading Agent
 *
 * Self-contained Node.js client that connects to live V3/V4 market data,
 * runs custom JavaScript policies against aggregated trade data,
 * and executes trades on Base chain using your own private key.
 *
 * Run:  PRIVATE_KEY=0x... node standalone-agent.js
 * Opts: RPC_URL=...  CONFIG_PATH=...  SERVER_URL=...
 *
 * Dependencies: ethers, socket.io-client (npm install ethers socket.io-client)
 */

const { ethers } = require("ethers");
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ═══════════════════════════════════════════════════════════════
// Section 1: Constants, ABIs & Config
// ═══════════════════════════════════════════════════════════════

const TOKEN_SWAPPER_ABI = [
  "function swap(address pair, uint amountIn, uint amountOutMin, bool isToken0In, uint taxPercent) external",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const UNISWAP_V3_ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
          { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        internalType: "struct ISwapRouter.ExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
];

const AERODROME_V3_ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "int24", name: "tickSpacing", type: "int24" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
          { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        internalType: "struct ISwapRouter.ExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
];

const UNIVERSAL_ROUTER_V4_ABI = [
  "function execute(bytes,bytes[],uint256) payable",
];

const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
];

const POOL_ABI = [
  "function tickSpacing() view returns (int24)",
];

// Contract addresses (Base chain)
const CONTRACTS = {
  tokenSwapper: "0x3b7b4f5CBffd457cD6E64C3C65e653bafD648Aa3",
  uniV3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
  aeroRouter: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  universalRouterV4: "0x6ff5693b99212da76ad316178a184ab56d299b43",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

// Known base tokens on Base chain
const WETH_BASE = "0x4200000000000000000000000000000000000006".toLowerCase();
const ZORA_BASE = "0x1111111111166b7fe7bd91427724b487980afc69".toLowerCase();
const CLANKER_BASE = "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb".toLowerCase();

// V4 constants
const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
};
const V4_COMMANDS = { V4_SWAP: 0x10 };

const feeToTickSpacing = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

// ── Config loading ──

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "agent-config.json");
const TRADES_PATH = process.env.TRADES_PATH || path.join(path.dirname(CONFIG_PATH), "agent-trades.json");
const TRADE_LOG_PATH = process.env.TRADE_LOG_PATH || path.join(path.dirname(CONFIG_PATH), "agent-trade-log.jsonl");
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || "31415", 10);

const DEFAULT_CONFIG = {
  maxEthPerTrade: 0.005,
  slippage: 10,
  maxPositions: 5,
  groupInterval: 1,
  maxGroups: 60,
  onlyPairs: [],
  excludePairs: [],
  policies: [],
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      const userConfig = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...userConfig };
    }
  } catch (err) {
    console.error(`[CONFIG] Error loading ${CONFIG_PATH}: ${err.message}, using defaults`);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to disk. Call this to persist policy changes made at runtime.
 * Agents can write their configs to agent-config.json and the standalone agent
 * will pick them up on next start, or call saveConfig() to persist mid-run.
 */
function saveConfig(configObj) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configObj, null, 2), "utf8");
    console.log(`[CONFIG] Saved to ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[CONFIG] Error saving ${CONFIG_PATH}: ${err.message}`);
  }
}

const config = loadConfig();

// ── Trade state persistence ──

function saveTrades() {
  try {
    const data = {
      activeTrades,
      inactiveTrades,
      summary: computeSummary(),
    };
    fs.writeFileSync(TRADES_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    log(`[TRADES] Error saving: ${err.message}`);
  }
}

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_PATH)) {
      const raw = fs.readFileSync(TRADES_PATH, "utf8");
      const saved = JSON.parse(raw);

      if (saved.activeTrades && typeof saved.activeTrades === "object" && !Array.isArray(saved.activeTrades)) {
        // New structured format
        for (const [pairAddress, trade] of Object.entries(saved.activeTrades)) {
          activeTrades[pairAddress] = trade;
        }
        if (Array.isArray(saved.inactiveTrades)) {
          inactiveTrades.push(...saved.inactiveTrades);
        }
        log(`[TRADES] Loaded ${Object.keys(saved.activeTrades).length} active, ${inactiveTrades.length} inactive trade(s) from ${TRADES_PATH}`);
      } else {
        // Old flat format: { pairAddress: trade, ... }
        let count = 0;
        for (const [pairAddress, trade] of Object.entries(saved)) {
          if (pairAddress === "summary") continue; // skip if somehow present
          activeTrades[pairAddress] = trade;
          count++;
        }
        log(`[TRADES] Migrated ${count} active trade(s) from old format in ${TRADES_PATH}`);
      }
    }
  } catch (err) {
    log(`[TRADES] Error loading: ${err.message}`);
  }
}

function appendTradeLog(entry) {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(TRADE_LOG_PATH, line, "utf8");
  } catch (err) {
    log(`[TRADE_LOG] Error appending: ${err.message}`);
  }
}

function computeSummary() {
  const activeList = Object.values(activeTrades);
  const openTrades = activeList.length;
  const closedTrades = inactiveTrades.length;

  // Unrealized PnL from active trades
  let unrealizedPnlEth = 0;
  let activeVolumeEth = 0;
  for (const t of activeList) {
    unrealizedPnlEth += (t.current_eth_value || 0) + (t.eth_sold || 0) - (t.eth_spent || 0);
    activeVolumeEth += t.eth_spent || 0;
  }

  // Realized PnL from closed trades
  let realizedPnlEth = 0;
  let inactiveVolumeEth = 0;
  let wins = 0;
  let losses = 0;
  let winPctSum = 0;
  let lossPctSum = 0;
  let roiPctSum = 0;

  for (const t of inactiveTrades) {
    const pnl = (t.eth_sold || 0) - (t.eth_spent || 0);
    realizedPnlEth += pnl;
    inactiveVolumeEth += t.eth_spent || 0;

    const roiPct = t.eth_spent > 0 ? (pnl / t.eth_spent) * 100 : 0;
    roiPctSum += roiPct;

    if ((t.eth_sold || 0) >= (t.eth_spent || 0)) {
      wins++;
      winPctSum += roiPct;
    } else {
      losses++;
      lossPctSum += roiPct;
    }
  }

  const wethPrice = usdPrices.WETH || 0;
  const volumeEth = activeVolumeEth + inactiveVolumeEth;

  return {
    open_trades: openTrades,
    closed_trades: closedTrades,
    unrealized_pnl_eth: unrealizedPnlEth,
    unrealized_pnl_usd: unrealizedPnlEth * wethPrice,
    realized_pnl_eth: realizedPnlEth,
    realized_pnl_usd: realizedPnlEth * wethPrice,
    wins,
    losses,
    avg_win_pct: wins > 0 ? winPctSum / wins : 0,
    avg_loss_pct: losses > 0 ? lossPctSum / losses : 0,
    win_rate_pct: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
    volume_eth: volumeEth,
    volume_usd: volumeEth * wethPrice,
    avg_roi_pct: closedTrades > 0 ? roiPctSum / closedTrades : 0,
    net_roi_pct: volumeEth > 0 ? ((realizedPnlEth + unrealizedPnlEth) / volumeEth) * 100 : 0,
    updated_at: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Section 2: Provider & Wallet Setup
// ═══════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SERVER_URL = process.env.SERVER_URL || "https://alpha.cssgod.io";

let provider;
let wallet;

// USD price cache — updated via usdRates_update events from the server
const usdPrices = { WETH: 0, ZORA: 0, CLANKER: 0, VIRTUAL: 0, SOL: 0, BNB: 0, BTC: 0 };

// Gas price cache — updated periodically
let gasPriceGwei = 0.01;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
// Section 3: Data Aggregation Engine
// ═══════════════════════════════════════════════════════════════

const computedPairData = {};
const activeTrades = {};
const executing = {}; // async lock per pair
const inactiveTrades = [];
const poolContractsCache = {};
let paused = false;
let controlServer = null;
const agentStartTime = Date.now();

function processPairUpdate(update) {
  // The marketData event from the relay includes { chain, timestamp, ...pairUpdateData }
  // Trade fields (last_price, buy_volume, etc.) may be nested inside a `data` sub-object
  const chain = update.chain || "base_v3";
  const inner = update.data || update;
  const data = { ...inner, ...update };

  // Extract pair address
  const pairAddress = (data.pairAddress || data.pair_address || inner.pair_address || "").toLowerCase();
  if (!pairAddress) return;

  // Apply pair filters
  if (config.onlyPairs.length > 0 && !config.onlyPairs.includes(pairAddress)) return;
  if (config.excludePairs.includes(pairAddress)) return;

  // Determine version from chain identifier
  const isV3 = chain.includes("v3");
  const isV4 = chain.includes("v4");
  const isV2 = !isV3 && !isV4;

  // Normalize fields
  const lastPrice = parseFloat(data.last_price || data.lastPrice || 0);
  const buyVolume = parseFloat(data.buy_volume || data.buyVolume || 0);
  const sellVolume = parseFloat(data.sell_volume || data.sellVolume || 0);
  const liquidity = parseFloat(data.liquidity || data.total_liquidity || 0);
  const minuteKey = data.minute_key || data.minuteKey || Math.floor(Date.now() / 60000);

  if (lastPrice <= 0) return;

  const normalized = {
    pairAddress,
    chain,
    isV3,
    isV4,
    isV2,
    last_price: lastPrice,
    buy_volume: buyVolume,
    sell_volume: sellVolume,
    liquidity,
    minuteKey,
    token0: (data.token0 || "").toLowerCase(),
    token1: (data.token1 || "").toLowerCase(),
    tokenAddress: (data.tokenAddress || data.token_address || "").toLowerCase(),
    fee: parseInt(data.fee || 0),
    fork: data.fork || (isV3 ? "uniswapV3" : ""),
    tickSpacing: data.tickSpacing ? parseInt(data.tickSpacing) : null,
    hooks: data.hooks || ethers.ZeroAddress,
    symbol: data.symbol || data.token_symbol || "",
    name: data.name || data.token_name || "",
    buy_tax: parseFloat(data.buy_tax || 0),
    sell_tax: parseFloat(data.sell_tax || 0),
    token0Decimals: parseInt(data.token0Decimals || 18),
    token1Decimals: parseInt(data.token1Decimals || 18),
  };

  integrateNewData(normalized);
}

function integrateNewData(data) {
  const { pairAddress, minuteKey } = data;
  const groupKey = Math.floor(minuteKey / config.groupInterval) * config.groupInterval;

  // Initialize pair data if new
  if (!computedPairData[pairAddress]) {
    computedPairData[pairAddress] = {
      groups: {},
      pairAddress,
      tokenAddress: data.tokenAddress,
      token0: data.token0,
      token1: data.token1,
      isV3: data.isV3,
      isV4: data.isV4,
      isV2: data.isV2,
      fee: data.fee,
      fork: data.fork,
      tickSpacing: data.tickSpacing,
      hooks: data.hooks,
      chain: data.chain,
      symbol: data.symbol,
      name: data.name,
      buy_tax: data.buy_tax,
      sell_tax: data.sell_tax,
      token0Decimals: data.token0Decimals,
      token1Decimals: data.token1Decimals,
      last_price: data.last_price,
      liquidity: data.liquidity,
      last_group_key: groupKey,
      first_seen: Date.now(),
    };
  }

  const pairData = computedPairData[pairAddress];

  // Update pair-level metadata
  pairData.last_price = data.last_price;
  pairData.liquidity = data.liquidity;
  if (data.symbol) pairData.symbol = data.symbol;
  if (data.name) pairData.name = data.name;
  if (data.fee) pairData.fee = data.fee;
  if (data.fork) pairData.fork = data.fork;
  if (data.tickSpacing) pairData.tickSpacing = data.tickSpacing;

  // Create group if new
  if (!pairData.groups[groupKey]) {
    pairData.groups[groupKey] = {
      first_price: data.last_price,
      last_price: data.last_price,
      min_price: data.last_price,
      max_price: data.last_price,
      price_change: 0,
      price_change_pct: 0,
      buy_volume: 0,
      sell_volume: 0,
      total_volume: 0,
      buy_count: 0,
      sell_count: 0,
      volatility: 0,
      groupKey,
    };
  }

  const group = pairData.groups[groupKey];

  // Update group OHLCV
  group.last_price = data.last_price;
  if (data.last_price > group.max_price) group.max_price = data.last_price;
  if (data.last_price < group.min_price) group.min_price = data.last_price;

  group.buy_volume += data.buy_volume;
  group.sell_volume += data.sell_volume;
  group.total_volume = group.buy_volume + group.sell_volume;

  if (data.buy_volume > 0) group.buy_count++;
  if (data.sell_volume > 0) group.sell_count++;

  // Price change within group
  if (group.first_price > 0) {
    group.price_change = group.last_price - group.first_price;
    group.price_change_pct = (group.price_change / group.first_price) * 100;
  }

  // Volatility: volume relative to liquidity
  if (data.liquidity > 0) {
    group.volatility = (group.total_volume / data.liquidity) * 100;
  }

  pairData.last_group_key = groupKey;

  // Evaluate policies
  if (!executing[pairAddress]) {
    if (activeTrades[pairAddress]) {
      evaluateExits(pairAddress, groupKey);
    } else {
      evaluateEntries(pairAddress, groupKey);
    }
  }
}

function cleanupOldGroups() {
  const maxGroups = config.maxGroups;
  for (const pairAddress of Object.keys(computedPairData)) {
    const pairData = computedPairData[pairAddress];
    const groupKeys = Object.keys(pairData.groups).map(Number).sort((a, b) => a - b);

    if (groupKeys.length > maxGroups) {
      const toRemove = groupKeys.slice(0, groupKeys.length - maxGroups);
      for (const key of toRemove) {
        delete pairData.groups[key];
      }
    }

    // Remove stale pairs with no recent data (30 min)
    const lastGroup = groupKeys[groupKeys.length - 1] || 0;
    const nowMinuteKey = Math.floor(Date.now() / 60000);
    if (nowMinuteKey - lastGroup > 30) {
      if (!activeTrades[pairAddress]) {
        delete computedPairData[pairAddress];
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Section 4: Policy Evaluation Engine
// ═══════════════════════════════════════════════════════════════

// Persistent custom data per pair — survives across evaluations.
// Policies can read/write ctx.customData to track state (e.g. counters, flags).
const pairCustomData = {};

// Global shared data across ALL pairs — survives across evaluations.
// Policies can read/write ctx.globalData to track market-wide state
// (e.g. regime detection, portfolio risk, cross-pair correlations).
const globalData = {};

// Compiled function cache — avoids re-compiling on every event
const compiledFuncs = {};

function compileFunc(key, code) {
  if (compiledFuncs[key]) return compiledFuncs[key];
  try {
    // The function receives a single `ctx` object and must return:
    //   false / 0        → no action
    //   true / 100       → full action (100%)
    //   number 1-99      → partial action at that percentage
    const fn = new Function("ctx", code);
    compiledFuncs[key] = fn;
    return fn;
  } catch (err) {
    log(`[POLICY] Compile error in "${key}": ${err.message}`);
    return null;
  }
}

/**
 * Build the context object passed to entryFunc / exitFunc.
 *
 * ctx = {
 *   event      — latest raw market data event
 *   group      — current aggregated group (OHLCV)
 *   groups     — array of all groups (oldest first)
 *   pair       — pair-level metadata (symbol, liquidity, etc.)
 *   trade      — active trade data (null for entry evaluation)
 *   customData — persistent object per pair, writable by the function
 * }
 */
function buildContext(pairAddress, groupKey, activeTrade, rawEvent) {
  const pairData = computedPairData[pairAddress];
  if (!pairData) return null;

  const groups = Object.values(pairData.groups);
  const currentGroup = pairData.groups[groupKey] || groups[groups.length - 1] || {};

  // Ensure persistent customData exists for this pair
  if (!pairCustomData[pairAddress]) {
    pairCustomData[pairAddress] = {};
  }

  return {
    // Latest raw event data
    event: rawEvent || {
      last_price: pairData.last_price,
      buy_volume: currentGroup.buy_volume || 0,
      sell_volume: currentGroup.sell_volume || 0,
      liquidity: pairData.liquidity,
    },

    // Current aggregated group
    group: {
      first_price: currentGroup.first_price || 0,
      last_price: currentGroup.last_price || 0,
      min_price: currentGroup.min_price || 0,
      max_price: currentGroup.max_price || 0,
      price_change: currentGroup.price_change || 0,
      price_change_pct: currentGroup.price_change_pct || 0,
      buy_volume: currentGroup.buy_volume || 0,
      sell_volume: currentGroup.sell_volume || 0,
      total_volume: currentGroup.total_volume || 0,
      buy_count: currentGroup.buy_count || 0,
      sell_count: currentGroup.sell_count || 0,
      volatility: currentGroup.volatility || 0,
    },

    // All groups for historical analysis (oldest → newest)
    groups,

    // Pair-level metadata
    pair: {
      pairAddress: pairData.pairAddress,
      tokenAddress: pairData.tokenAddress,
      symbol: pairData.symbol,
      name: pairData.name,
      current_price: pairData.last_price,
      liquidity: pairData.liquidity,
      buy_tax: pairData.buy_tax,
      sell_tax: pairData.sell_tax,
      isV3: pairData.isV3,
      isV4: pairData.isV4,
      isV2: pairData.isV2,
      fee: pairData.fee,
      fork: pairData.fork,
      chain: pairData.chain,
    },

    // Active trade (null when evaluating entries)
    trade: activeTrade ? {
      entry_price: activeTrade.price_at_buy || activeTrade.entry_price,
      current_price: activeTrade.current_price,
      price_change_pct: activeTrade.price_change_pct || 0,
      eth_spent: activeTrade.eth_spent,
      eth_sold: activeTrade.eth_sold,
      current_eth_value: activeTrade.current_eth_value,
      tokens_in_possession: activeTrade.tokens_in_possession,
      min_price_since_entry: activeTrade.min_price_since_entry,
      max_price_since_entry: activeTrade.max_price_since_entry,
      opened_at: activeTrade.opened_at,
      age_ms: Date.now() - (activeTrade.opened_at || Date.now()),
    } : null,

    // USD prices for base assets (updated periodically from server)
    prices: { ...usdPrices },

    // Current gas price
    gas: { price_gwei: gasPriceGwei },

    // Persistent per-pair custom data — write anything here, it survives across events
    customData: pairCustomData[pairAddress],

    // Global shared data across all pairs — use for market regime, portfolio tracking, cross-pair signals
    globalData,
  };
}

function evaluateEntries(pairAddress, groupKey) {
  if (paused) return;
  const pairData = computedPairData[pairAddress];
  if (!pairData) return;

  // Check position limit
  const activeCount = Object.keys(activeTrades).length;
  if (activeCount >= config.maxPositions) return;

  // Already have a trade on this pair
  if (activeTrades[pairAddress]) return;

  for (const policy of config.policies) {
    if (!policy.entryFunc) continue;

    const fn = compileFunc(`entry:${policy.id}`, policy.entryFunc);
    if (!fn) continue;

    const ctx = buildContext(pairAddress, groupKey, null);
    if (!ctx) continue;

    try {
      const result = fn(ctx);
      const actionValue = result === true ? 100 : (typeof result === "number" ? Math.min(Math.max(result, 0), 100) : 0);

      if (actionValue > 0) {
        log(`[ENTRY] Policy "${policy.id}" triggered for ${pairData.symbol || pairAddress} (action=${actionValue})`);
        executeBuy(pairAddress, pairData, policy, actionValue);
        return; // One buy per evaluation cycle
      }
    } catch (err) {
      log(`[POLICY] entryFunc error for "${policy.id}" on ${pairData.symbol || pairAddress}: ${err.message}`);
    }
  }
}

function evaluateExits(pairAddress, groupKey) {
  if (paused) return;
  const trade = activeTrades[pairAddress];
  if (!trade) return;

  const pairData = computedPairData[pairAddress];
  if (!pairData) return;

  // Update active trade metrics
  updateActiveTradeData(trade, pairData);

  for (const policy of config.policies) {
    if (!policy.exitFunc) continue;

    const fn = compileFunc(`exit:${policy.id}`, policy.exitFunc);
    if (!fn) continue;

    const ctx = buildContext(pairAddress, groupKey, trade);
    if (!ctx) continue;

    try {
      const result = fn(ctx);
      const actionValue = result === true ? 100 : (typeof result === "number" ? Math.min(Math.max(result, 0), 100) : 0);

      if (actionValue > 0) {
        log(`[EXIT] Policy "${policy.id}" triggered for ${pairData.symbol || pairAddress} (action=${actionValue})`);
        executeSell(pairAddress, trade, actionValue);
        return;
      }
    } catch (err) {
      log(`[POLICY] exitFunc error for "${policy.id}" on ${pairData.symbol || pairAddress}: ${err.message}`);
    }
  }
}

function updateActiveTradeData(trade, pairData) {
  if (!pairData || !pairData.last_price) return;

  const currentPrice = pairData.last_price;
  const entryPrice = trade.price_at_buy || trade.entry_price;

  if (entryPrice > 0) {
    trade.price_change_pct = ((currentPrice - entryPrice) / entryPrice) * 100;
  }

  trade.current_price = currentPrice;

  // Track min/max since entry
  if (!trade.min_price_since_entry || currentPrice < trade.min_price_since_entry) {
    trade.min_price_since_entry = currentPrice;
  }
  if (!trade.max_price_since_entry || currentPrice > trade.max_price_since_entry) {
    trade.max_price_since_entry = currentPrice;
  }

  // Estimate current ETH value (remaining tokens only, not tokens already sold)
  if (trade.tokens_in_possession && currentPrice > 0) {
    trade.current_eth_value = trade.tokens_in_possession * currentPrice;
  }
}

/**
 * Check on-chain ERC20 balances for all active trades.
 * - If balance is 0 → remove the trade from activeTrades.
 * - Otherwise → update tokens_in_possession from the real balance.
 * Called on startup (after loading saved trades) and periodically.
 */
async function checkTradeBalances() {
  const pairs = Object.keys(activeTrades);
  if (pairs.length === 0) return;

  log(`[BALANCE] Checking on-chain balances for ${pairs.length} active trade(s)...`);
  let changed = false;

  for (const pairAddress of pairs) {
    const trade = activeTrades[pairAddress];
    if (!trade) continue;

    let tokenAddress = trade.tokenAddress;
    if (!tokenAddress && trade.token0 && trade.token1) {
      tokenAddress = trade.token0.toLowerCase() === (trade.baseToken || detectBaseToken(trade.token0, trade.token1))
        ? trade.token1
        : trade.token0;
    }
    if (!tokenAddress) {
      log(`[BALANCE] ${trade.symbol || pairAddress}: no tokenAddress, skipping (waiting for feed data)`);
      continue;
    }

    try {
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const balance = await tokenContract.balanceOf(wallet.address);

      if (balance === 0n) {
        log(`[BALANCE] ${trade.symbol || pairAddress}: balance is 0, archiving trade`);
        const pnlEth = (trade.eth_sold || 0) - (trade.eth_spent || 0);
        const pnlPct = trade.eth_spent > 0 ? (pnlEth / trade.eth_spent) * 100 : 0;
        inactiveTrades.push({ ...trade, exit_price: trade.current_price || 0, closed_at: Date.now(), realized_pnl_eth: pnlEth, realized_pnl_pct: pnlPct, close_reason: "zero_balance" });
        delete activeTrades[pairAddress];
        changed = true;
      } else {
        let tokenDecimals = 18;
        try {
          tokenDecimals = Number(await tokenContract.decimals());
        } catch { /* default 18 */ }

        trade.tokens_in_possession = parseFloat(formatTokenAmount(balance, tokenDecimals));
        trade.tokens_in_possession_hex = balance.toString();
        log(`[BALANCE] ${trade.symbol || pairAddress}: ${trade.tokens_in_possession} tokens`);
        changed = true;
      }
    } catch (err) {
      log(`[BALANCE] Error checking ${trade.symbol || pairAddress}: ${err.message}`);
    }
  }

  if (changed) saveTrades();
}

// ═══════════════════════════════════════════════════════════════
// Section 5: Trade Execution Engine
// ═══════════════════════════════════════════════════════════════

async function getGasConfig() {
  try {
    const feeData = await provider.getFeeData();

    const baseGasPriceGwei = feeData?.gasPrice
      ? parseFloat(ethers.formatUnits(feeData.gasPrice, "gwei"))
      : 0.01;

    const basePriorityFeeGwei = feeData?.maxPriorityFeePerGas
      ? Math.max(0.01, parseFloat(ethers.formatUnits(feeData.maxPriorityFeePerGas, "gwei")))
      : Math.max(0.01, baseGasPriceGwei * 0.1);

    const gasMultiplier = 1.01;
    const priorityFeeGwei = basePriorityFeeGwei * gasMultiplier;
    const maxFeeGwei = (baseGasPriceGwei + priorityFeeGwei) * gasMultiplier;

    return {
      maxFeePerGas: ethers.parseUnits(maxFeeGwei.toFixed(9), "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits(priorityFeeGwei.toFixed(9), "gwei"),
      type: 2,
    };
  } catch (error) {
    log(`[GAS] Error fetching gas config, using fallback: ${error.message}`);
    return {
      maxFeePerGas: ethers.parseUnits("0.05", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
      type: 2,
    };
  }
}

async function sendTransactionWithRetry(txFn, maxRetries = 3) {
  let attempts = 0;
  let lastError;
  let currentNonce = await wallet.getNonce();

  while (attempts < maxRetries) {
    try {
      attempts++;
      log(`[TX] Attempt ${attempts} with nonce ${currentNonce}`);
      const txResponse = await txFn(currentNonce);
      log(`[TX] Sent, waiting for confirmation...`);
      const receipt = await txResponse.wait();
      log(`[TX] Confirmed: ${receipt.hash}`);
      return receipt;
    } catch (error) {
      lastError = error;
      log(`[TX] Attempt ${attempts} failed: ${error.message}`);

      if (error.code === "NONCE_EXPIRED" || (error.message && error.message.includes("nonce too low"))) {
        log("[TX] Nonce issue, fetching latest nonce...");
        currentNonce = await wallet.getNonce("latest");
      } else if (error.code === "NETWORK_ERROR") {
        log("[TX] Network error, retrying...");
        await new Promise((r) => setTimeout(r, 250));
      } else {
        log("[TX] Non-recoverable error, not retrying.");
        break;
      }
    }
  }

  throw lastError;
}

async function approveToken(tokenAddress, spender, amount) {
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  let currentAllowance = 0n;
  for (let i = 0; i < 3; i++) {
    try {
      currentAllowance = await tokenContract.allowance(wallet.address, spender);
      break;
    } catch (error) {
      log(`[APPROVE] Allowance check attempt ${i + 1} failed: ${error.message}`);
      if (i === 2) currentAllowance = 0n;
      else await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const amountBig = BigInt(amount.toString());
  if (currentAllowance >= amountBig) {
    return;
  }

  log(`[APPROVE] Approving ${spender} for ${tokenAddress}...`);
  const receipt = await sendTransactionWithRetry(async (nonce) => {
    const gasConfig = await getGasConfig();
    return tokenContract.approve(spender, ethers.MaxUint256, {
      nonce,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
      value: 0,
    });
  });

  log(`[APPROVE] Confirmed: ${receipt.hash}`);
}

async function approvePermit2ToRouter(tokenAddress, amount) {
  const permit2Contract = new ethers.Contract(CONTRACTS.permit2, PERMIT2_ABI, wallet);

  let allowanceData = { amount: 0n, expiration: 0 };
  for (let i = 0; i < 3; i++) {
    try {
      allowanceData = await permit2Contract.allowance(
        wallet.address,
        tokenAddress,
        CONTRACTS.universalRouterV4
      );
      break;
    } catch (error) {
      log(`[PERMIT2] Check attempt ${i + 1} failed: ${error.message}`);
      if (i < 2) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const currentAmount = BigInt(allowanceData.amount.toString());
  const requiredAmount = BigInt(amount.toString());
  const currentTime = Math.floor(Date.now() / 1000);
  const expiration = Number(allowanceData.expiration);

  if (currentAmount >= requiredAmount && expiration > currentTime) {
    return;
  }

  log("[PERMIT2] Approving Permit2 -> Universal Router...");
  const maxUint160 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  const futureExpiration = currentTime + 30 * 24 * 60 * 60; // 30 days

  const receipt = await sendTransactionWithRetry(async (nonce) => {
    const gasConfig = await getGasConfig();
    return permit2Contract.approve(
      tokenAddress,
      CONTRACTS.universalRouterV4,
      maxUint160,
      futureExpiration,
      {
        nonce,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        value: 0,
      }
    );
  });

  log(`[PERMIT2] Confirmed: ${receipt.hash}`);
}

function detectBaseToken(token0, token1) {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (t0 === ZORA_BASE || t1 === ZORA_BASE) return ZORA_BASE;
  if (t0 === CLANKER_BASE || t1 === CLANKER_BASE) return CLANKER_BASE;
  return WETH_BASE;
}

function formatTokenAmount(amountBig, decimals) {
  const amount = BigInt(amountBig.toString());
  const divisor = 10n ** BigInt(decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;
  let fractionalStr = fractionalPart.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fractionalStr === "") fractionalStr = "0";
  return `${wholePart}.${fractionalStr}`;
}

async function getPoolTickSpacing(pairAddress) {
  if (poolContractsCache[pairAddress]) return poolContractsCache[pairAddress];
  const contract = new ethers.Contract(pairAddress, POOL_ABI, provider);
  const tickSpacing = await contract.tickSpacing();
  poolContractsCache[pairAddress] = tickSpacing.toString();
  return poolContractsCache[pairAddress];
}

// ── Swap routing ──

async function performSwap({ tradeData, amountIn, isToken0In, minAmountOut = 0, action = "buy" }) {
  try {
    if (tradeData.isV2) {
      return await swapV2({ tradeData, amountIn, isToken0In, minAmountOut, action });
    } else if (tradeData.isV3) {
      return await swapV3({ tradeData, amountIn, isToken0In, minAmountOut, action });
    } else if (tradeData.isV4) {
      return await swapV4({ tradeData, amountIn, isToken0In, minAmountOut, action });
    } else {
      throw new Error("Unsupported pool type");
    }
  } catch (e) {
    return {
      success: false,
      message: `${action} failed`,
      error: e.message || e,
    };
  }
}

async function swapV2({ tradeData, amountIn, isToken0In, minAmountOut, action }) {
  const swapper = new ethers.Contract(CONTRACTS.tokenSwapper, TOKEN_SWAPPER_ABI, wallet);
  const taxValue = Math.round(action === "buy" ? (tradeData.buy_tax || 0) : (tradeData.sell_tax || 0));
  const swapDirection = action === "sell" ? !isToken0In : isToken0In;

  const receipt = await sendTransactionWithRetry(async (nonce) => {
    const gasConfig = await getGasConfig();
    return swapper.swap(
      tradeData.pairAddress,
      amountIn,
      minAmountOut,
      swapDirection,
      taxValue,
      {
        nonce,
        gasLimit: 300000,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        value: 0,
      }
    );
  });

  const tokenDecimals = isToken0In ? (tradeData.token1Decimals || 18) : (tradeData.token0Decimals || 18);
  return parseTransactionLogs(receipt, tokenDecimals);
}

async function swapV3({ tradeData, amountIn, isToken0In, minAmountOut, action }) {
  let tokenIn, tokenOut;
  if (action === "sell") {
    tokenIn = isToken0In ? tradeData.token1 : tradeData.token0;
    tokenOut = isToken0In ? tradeData.token0 : tradeData.token1;
  } else {
    tokenIn = isToken0In ? tradeData.token0 : tradeData.token1;
    tokenOut = isToken0In ? tradeData.token1 : tradeData.token0;
  }

  log(`[SWAP] V3 ${action}: ${tokenIn} -> ${tokenOut}`);

  const params = {
    tokenIn,
    tokenOut,
    fee: tradeData.fee * 10000,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 30,
    amountIn,
    amountOutMinimum: minAmountOut,
    sqrtPriceLimitX96: 0,
  };

  let routerAddress;
  if (tradeData.fork === "aerodrome") {
    routerAddress = CONTRACTS.aeroRouter;
    const tickSpacing = await getPoolTickSpacing(tradeData.pairAddress);
    params.tickSpacing = tickSpacing;
    delete params.fee;
  } else {
    routerAddress = CONTRACTS.uniV3Router;
  }

  const routerABI = tradeData.fork === "aerodrome" ? AERODROME_V3_ROUTER_ABI : UNISWAP_V3_ROUTER_ABI;
  const router = new ethers.Contract(routerAddress, routerABI, wallet);

  const receipt = await sendTransactionWithRetry(async (nonce) => {
    const gasConfig = await getGasConfig();
    return router.exactInputSingle(params, {
      nonce,
      gasLimit: 800000,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
      value: 0,
    });
  });

  const tokenDecimals = isToken0In ? (tradeData.token1Decimals || 18) : (tradeData.token0Decimals || 18);
  const effectiveIsToken0In = action === "sell" ? !isToken0In : isToken0In;
  return parseTransactionLogsV3(receipt, tokenDecimals, effectiveIsToken0In);
}

async function swapV4({ tradeData, amountIn, isToken0In, minAmountOut, action }) {
  if (!amountIn || amountIn.toString() === "0") {
    throw new Error("Invalid amountIn for V4 swap");
  }

  const universalRouter = new ethers.Contract(
    CONTRACTS.universalRouterV4,
    UNIVERSAL_ROUTER_V4_ABI,
    wallet
  );

  // Canonical token ordering
  let token0 = tradeData.token0;
  let token1 = tradeData.token1;
  if (token0.toLowerCase() > token1.toLowerCase()) {
    [token0, token1] = [token1, token0];
  }

  let tickSpacing = tradeData.tickSpacing;
  if (!tickSpacing) {
    tickSpacing = feeToTickSpacing[tradeData.fee] || 60;
  }

  const poolKey = {
    currency0: token0,
    currency1: token1,
    fee: tradeData.fee,
    tickSpacing,
    hooks: tradeData.hooks || ethers.ZeroAddress,
  };

  const baseTokenAddress = detectBaseToken(token0, token1);
  const baseTokenIsToken0 = token0.toLowerCase() === baseTokenAddress.toLowerCase();
  const correctedIsToken0In = action === "buy" ? baseTokenIsToken0 : !baseTokenIsToken0;

  log(`[SWAP] V4 ${action}: zeroForOne=${correctedIsToken0In}`);

  const actions = ethers.solidityPacked(
    ["uint8", "uint8", "uint8"],
    [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
  );

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const swapParam = abiCoder.encode(
    ["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
    [[
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      correctedIsToken0In,
      amountIn,
      minAmountOut,
      "0x",
    ]]
  );

  const settleParam = abiCoder.encode(
    ["address", "uint128"],
    [correctedIsToken0In ? token0 : token1, amountIn]
  );

  const takeParam = abiCoder.encode(
    ["address", "uint128"],
    [correctedIsToken0In ? token1 : token0, minAmountOut]
  );

  const v4Input = abiCoder.encode(
    ["bytes", "bytes[]"],
    [actions, [swapParam, settleParam, takeParam]]
  );

  const commands = ethers.solidityPacked(["uint8"], [V4_COMMANDS.V4_SWAP]);
  const inputs = [v4Input];
  const deadline = Math.floor(Date.now() / 1000) + 60;

  // Pre-flight simulation
  try {
    await universalRouter["execute(bytes,bytes[],uint256)"].staticCall(
      commands, inputs, deadline, { value: 0 }
    );
    log("[SWAP] V4 pre-flight simulation passed");
  } catch (simError) {
    log(`[SWAP] V4 pre-flight simulation failed: ${simError.message}`);
  }

  const receipt = await sendTransactionWithRetry(async (nonce) => {
    const gasConfig = await getGasConfig();
    return universalRouter["execute(bytes,bytes[],uint256)"](
      commands, inputs, deadline,
      {
        nonce,
        gasLimit: 800000,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        type: 2,
        value: 0,
      }
    );
  });

  const tokenDecimals = isToken0In ? (tradeData.token1Decimals || 18) : (tradeData.token0Decimals || 18);
  return parseTransactionLogsV4(receipt, tokenDecimals, isToken0In);
}

// ── Transaction log parsing ──

function parseTransactionLogs(txReceipt, tokenDecimals) {
  try {
    const transferEventSignature = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const normalizedWallet = "0x" + wallet.address.toLowerCase().slice(2).padStart(64, "0");

    const transferLog = txReceipt.logs.find(
      (log) =>
        log.topics[0] === transferEventSignature &&
        log.topics[2] &&
        log.topics[2].toLowerCase() === normalizedWallet
    );

    if (!transferLog) {
      return { success: false, message: "Could not find transfer event in transaction logs" };
    }

    const amountBig = BigInt(transferLog.data);
    const readableAmount = formatTokenAmount(amountBig, tokenDecimals);

    return { success: true, amountHex: amountBig.toString(), readableAmount };
  } catch (error) {
    return { success: false, message: "Transaction log parsing failed", error: error.message };
  }
}

function parseSwapLog(swapLog, tokenDecimals, isToken0In) {
  const dataHex = swapLog.data.startsWith("0x") ? swapLog.data.slice(2) : swapLog.data;

  function parseSignedInt256(hex) {
    hex = hex.padStart(64, "0");
    const val = BigInt("0x" + hex);
    const max = (1n << 255n) - 1n;
    return val > max ? val - (1n << 256n) : val;
  }

  const amount0 = parseSignedInt256(dataHex.slice(0, 64));
  const amount1 = parseSignedInt256(dataHex.slice(64, 128));

  let tokenOutAmount = isToken0In ? amount1 : amount0;
  if (tokenOutAmount < 0n) tokenOutAmount = -tokenOutAmount;

  const readableAmount = formatTokenAmount(tokenOutAmount, tokenDecimals);
  return { success: true, amountHex: tokenOutAmount.toString(), readableAmount };
}

function parseTransactionLogsV3(txReceipt, tokenDecimals, isToken0In) {
  try {
    const swapEventSignature = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
    const swapLog = txReceipt.logs.find((l) => l.topics[0].toLowerCase() === swapEventSignature);

    if (!swapLog) {
      return { success: false, message: "Could not find swap event in transaction logs" };
    }

    return parseSwapLog(swapLog, tokenDecimals, isToken0In);
  } catch (error) {
    return { success: false, message: "V3 log parsing failed", error: error.message };
  }
}

function parseTransactionLogsV4(txReceipt, tokenDecimals, isToken0In) {
  try {
    const transferEventSignature = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const normalizedWallet = "0x" + wallet.address.toLowerCase().slice(2).padStart(64, "0");

    const transferLogs = txReceipt.logs.filter(
      (l) =>
        l.topics[0] === transferEventSignature &&
        l.topics[2] &&
        l.topics[2].toLowerCase() === normalizedWallet
    );

    if (transferLogs.length === 0) {
      // Fallback: try V3 Swap event parsing
      const swapEventSignature = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
      const swapLog = txReceipt.logs.find((l) => l.topics[0].toLowerCase() === swapEventSignature);
      if (swapLog) {
        return parseSwapLog(swapLog, tokenDecimals, isToken0In);
      }
      return { success: false, message: "No transfer or swap logs found for V4 transaction" };
    }

    const transferLog = transferLogs[transferLogs.length - 1];
    const amountBig = BigInt(transferLog.data);
    const readableAmount = formatTokenAmount(amountBig, tokenDecimals);

    return { success: true, amountHex: amountBig.toString(), readableAmount };
  } catch (error) {
    return { success: false, message: "V4 log parsing failed", error: error.message };
  }
}

// ── Buy / Sell execution ──

async function executeBuy(pairAddress, pairData, policy, actionPercent) {
  if (executing[pairAddress]) return;
  executing[pairAddress] = true;

  try {
    const ethAmount = config.maxEthPerTrade * (actionPercent / 100);
    const amountIn = ethers.parseEther(ethAmount.toFixed(18));

    const baseTokenAddress = detectBaseToken(pairData.token0, pairData.token1);
    const isToken0In = pairData.token0.toLowerCase() === baseTokenAddress.toLowerCase();

    // Determine spender for approval
    let spender;
    if (pairData.isV4) {
      spender = CONTRACTS.permit2;
    } else if (pairData.isV3) {
      spender = pairData.fork === "aerodrome" ? CONTRACTS.aeroRouter : CONTRACTS.uniV3Router;
    } else {
      spender = CONTRACTS.tokenSwapper;
    }

    log(`[BUY] ${pairData.symbol || pairAddress} | ${ethAmount.toFixed(6)} ETH | V${pairData.isV4 ? "4" : pairData.isV3 ? "3" : "2"}`);

    // Approve base token
    await approveToken(baseTokenAddress, spender, amountIn);

    // V4 also needs Permit2 -> Universal Router approval
    if (pairData.isV4) {
      await approvePermit2ToRouter(baseTokenAddress, amountIn);
    }

    const minAmountOut = 0; // Slippage protection handled by on-chain execution

    const tradeData = {
      pairAddress: pairData.pairAddress,
      token0: pairData.token0,
      token1: pairData.token1,
      isV2: pairData.isV2,
      isV3: pairData.isV3,
      isV4: pairData.isV4,
      fee: pairData.fee,
      fork: pairData.fork,
      tickSpacing: pairData.tickSpacing,
      hooks: pairData.hooks,
      buy_tax: pairData.buy_tax,
      sell_tax: pairData.sell_tax,
      token0Decimals: pairData.token0Decimals,
      token1Decimals: pairData.token1Decimals,
    };

    const result = await performSwap({
      tradeData,
      amountIn,
      isToken0In,
      minAmountOut,
      action: "buy",
    });

    if (!result.success) {
      log(`[BUY] Failed for ${pairData.symbol || pairAddress}: ${result.message || result.error}`);
      appendTradeLog({ type: "BUY", status: "FAILED", symbol: pairData.symbol, pairAddress, policy_id: policy.id, action_percent: actionPercent, eth_amount: ethAmount, error: result.message || result.error });
      return;
    }

    const tokensBought = parseFloat(result.readableAmount);

    // Create active trade record
    activeTrades[pairAddress] = {
      pairAddress,
      symbol: pairData.symbol,
      name: pairData.name,
      token0: pairData.token0,
      token1: pairData.token1,
      isV3: pairData.isV3,
      isV4: pairData.isV4,
      isV2: pairData.isV2,
      fee: pairData.fee,
      fork: pairData.fork,
      tickSpacing: pairData.tickSpacing,
      hooks: pairData.hooks,
      buy_tax: pairData.buy_tax,
      sell_tax: pairData.sell_tax,
      token0Decimals: pairData.token0Decimals,
      token1Decimals: pairData.token1Decimals,
      entry_price: pairData.last_price,
      price_at_buy: pairData.last_price,
      eth_spent: ethAmount,
      eth_bought: ethAmount,
      eth_sold: 0,
      tokens_bought: tokensBought,
      tokens_in_possession: tokensBought,
      tokens_in_possession_hex: result.amountHex,
      current_price: pairData.last_price,
      price_change_pct: 0,
      min_price_since_entry: pairData.last_price,
      max_price_since_entry: pairData.last_price,
      current_eth_value: ethAmount,
      value_at_buy: ethAmount,
      opened_at: Date.now(),
      policy_id: policy.id,
      tokenAddress: pairData.tokenAddress,
      baseToken: detectBaseToken(pairData.token0, pairData.token1),
    };

    log(`[BUY] SUCCESS: ${pairData.symbol || pairAddress} | Got ${result.readableAmount} tokens for ${ethAmount.toFixed(6)} ETH`);
    appendTradeLog({ type: "BUY", status: "SUCCESS", symbol: pairData.symbol, pairAddress, policy_id: policy.id, action_percent: actionPercent, eth_amount: ethAmount, tokens_received: result.amountHex, price: pairData.last_price });
    saveTrades();
  } catch (error) {
    log(`[BUY] ERROR: ${pairData.symbol || pairAddress}: ${error.message}`);
    appendTradeLog({ type: "BUY", status: "ERROR", symbol: pairData.symbol, pairAddress, policy_id: policy.id, action_percent: actionPercent, eth_amount: config.maxEthPerTrade * (actionPercent / 100), error: error.message });
  } finally {
    executing[pairAddress] = false;
  }
}

async function executeSell(pairAddress, trade, actionPercent) {
  if (executing[pairAddress]) return;
  executing[pairAddress] = true;

  try {
    // Query actual on-chain balance
    const tokenAddress = trade.tokenAddress || (
      trade.token0.toLowerCase() === trade.baseToken
        ? trade.token1
        : trade.token0
    );

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    let actualBalance;
    try {
      actualBalance = await tokenContract.balanceOf(wallet.address);
    } catch {
      actualBalance = BigInt(trade.tokens_in_possession_hex || "0");
    }

    if (actualBalance === 0n) {
      log(`[SELL] No tokens to sell for ${trade.symbol || pairAddress}, closing trade`);
      const pnlEth = (trade.eth_sold || 0) - (trade.eth_spent || 0);
      const pnlPct = trade.eth_spent > 0 ? (pnlEth / trade.eth_spent) * 100 : 0;
      inactiveTrades.push({ ...trade, exit_price: trade.current_price || 0, closed_at: Date.now(), realized_pnl_eth: pnlEth, realized_pnl_pct: pnlPct, close_reason: "zero_balance" });
      delete activeTrades[pairAddress];
      saveTrades();
      return;
    }

    // Calculate sell amount based on actionPercent
    const sellAmount = (actualBalance * BigInt(Math.min(actionPercent, 100))) / 100n;

    if (sellAmount === 0n) {
      log(`[SELL] Sell amount is 0 for ${trade.symbol || pairAddress}`);
      return;
    }

    const baseTokenAddress = trade.baseToken || detectBaseToken(trade.token0, trade.token1);
    const isToken0In = trade.token0.toLowerCase() === baseTokenAddress.toLowerCase();

    // Determine spender for approval
    let spender;
    if (trade.isV4) {
      spender = CONTRACTS.permit2;
    } else if (trade.isV3) {
      spender = trade.fork === "aerodrome" ? CONTRACTS.aeroRouter : CONTRACTS.uniV3Router;
    } else {
      spender = CONTRACTS.tokenSwapper;
    }

    log(`[SELL] ${trade.symbol || pairAddress} | ${actionPercent}% | PnL: ${(trade.price_change_pct || 0).toFixed(2)}%`);

    // Approve token being sold
    await approveToken(tokenAddress, spender, sellAmount);

    if (trade.isV4) {
      await approvePermit2ToRouter(tokenAddress, sellAmount);
    }

    const tradeData = {
      pairAddress: trade.pairAddress,
      token0: trade.token0,
      token1: trade.token1,
      isV2: trade.isV2,
      isV3: trade.isV3,
      isV4: trade.isV4,
      fee: trade.fee,
      fork: trade.fork,
      tickSpacing: trade.tickSpacing,
      hooks: trade.hooks,
      buy_tax: trade.buy_tax,
      sell_tax: trade.sell_tax,
      token0Decimals: trade.token0Decimals,
      token1Decimals: trade.token1Decimals,
    };

    const result = await performSwap({
      tradeData,
      amountIn: sellAmount,
      isToken0In,
      minAmountOut: 0,
      action: "sell",
    });

    if (!result.success) {
      log(`[SELL] Failed for ${trade.symbol || pairAddress}: ${result.message || result.error}`);
      appendTradeLog({ type: "SELL", status: "FAILED", symbol: trade.symbol, pairAddress, policy_id: trade.policy_id, action_percent: actionPercent, error: result.message || result.error });
      return;
    }

    const ethReceived = parseFloat(result.readableAmount || "0");
    trade.eth_sold += ethReceived;

    if (actionPercent >= 100) {
      const totalPnl = trade.eth_sold - trade.eth_spent;
      const pnlPct = trade.eth_spent > 0 ? (totalPnl / trade.eth_spent) * 100 : 0;
      log(`[SELL] CLOSED: ${trade.symbol || pairAddress} | Received ${ethReceived.toFixed(6)} ETH | Total PnL: ${totalPnl.toFixed(6)} ETH (${pnlPct.toFixed(2)}%)`);
      inactiveTrades.push({ ...trade, exit_price: trade.current_price || 0, closed_at: Date.now(), realized_pnl_eth: totalPnl, realized_pnl_pct: pnlPct });
      delete activeTrades[pairAddress];
    } else {
      // Partial sell: update remaining tokens
      const remainingBalance = actualBalance - sellAmount;
      trade.tokens_in_possession = parseFloat(formatTokenAmount(remainingBalance, trade.token0Decimals || 18));
      trade.tokens_in_possession_hex = remainingBalance.toString();
      log(`[SELL] PARTIAL: ${trade.symbol || pairAddress} | Sold ${actionPercent}% | Received ${ethReceived.toFixed(6)} ETH`);
    }

    appendTradeLog({ type: "SELL", status: "SUCCESS", symbol: trade.symbol, pairAddress, policy_id: trade.policy_id, action_percent: actionPercent, eth_received: ethReceived, price: trade.current_price, realized_pnl_eth: trade.eth_sold - trade.eth_spent });
    saveTrades();
  } catch (error) {
    log(`[SELL] ERROR: ${trade.symbol || pairAddress}: ${error.message}`);
    appendTradeLog({ type: "SELL", status: "ERROR", symbol: trade.symbol, pairAddress, policy_id: trade.policy_id, action_percent: actionPercent, error: error.message });
  } finally {
    executing[pairAddress] = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Section 6: WebSocket Feed Connection
// ═══════════════════════════════════════════════════════════════

let socket;
let updateCount = 0;
let totalUpdateCount = 0;

function connectToFeed() {
  log(`[FEED] Connecting to ${SERVER_URL}...`);

  socket = io(SERVER_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  socket.on("connect", () => {
    log(`[FEED] Connected to server (socket ${socket.id})`);
    // Subscribe to market data channels
    socket.emit("subscribeMarketData", { chains: ["base_v3", "base_v4"] });
  });

  socket.on("subscribeMarketDataAck", (data) => {
    log(`[FEED] Subscribed to chains: ${data.chains.join(", ")}`);
  });

  socket.on("marketData", (update) => {
    updateCount++;
    totalUpdateCount++;
    if (totalUpdateCount % 200 === 0) {
      log(`[FEED] ${totalUpdateCount} total events received`);
    }
    processPairUpdate(update);
  });

  // Track USD prices for base assets
  socket.on("usdRates_update", (rates) => {
    if (rates) {
      for (const key of Object.keys(usdPrices)) {
        if (rates[key] !== undefined) usdPrices[key] = rates[key];
      }
    }
  });

  socket.on("disconnect", (reason) => {
    log(`[FEED] Disconnected: ${reason}`);
  });

  socket.on("connect_error", (error) => {
    log(`[FEED] Connection error: ${error.message}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 7: HTTP Control Server
// ═══════════════════════════════════════════════════════════════

/**
 * Parse JSON body from an incoming HTTP request.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Start the HTTP control server on CONTROL_PORT.
 * Binds to 127.0.0.1 only (security: trade execution capability).
 */
function startControlServer() {
  controlServer = http.createServer(async (req, res) => {
    const method = req.method;
    const url = req.url.split("?")[0]; // strip query string

    try {
      // ── GET /status ──────────────────────────────────────────
      if (method === "GET" && url === "/status") {
        const summary = computeSummary();
        const trades = {};
        for (const [addr, t] of Object.entries(activeTrades)) {
          trades[addr] = {
            symbol: t.symbol || "",
            entry_price: t.entry_price,
            current_price: t.current_price,
            price_change_pct: parseFloat((t.price_change_pct || 0).toFixed(2)),
            eth_spent: t.eth_spent,
            eth_sold: t.eth_sold || 0,
            current_eth_value: t.current_eth_value || 0,
            tokens_in_possession: t.tokens_in_possession,
            tokens_bought: t.tokens_bought,
            policy_id: t.policy_id,
            opened_at: t.opened_at,
          };
        }
        return sendJson(res, 200, {
          paused,
          uptime_seconds: Math.floor((Date.now() - agentStartTime) / 1000),
          pairs_tracked: Object.keys(computedPairData).length,
          wallet: wallet ? wallet.address : null,
          active_trades: trades,
          summary,
        });
      }

      // ── GET /balances ────────────────────────────────────────
      if (method === "GET" && url === "/balances") {
        await checkTradeBalances();
        const balances = {};
        for (const [addr, t] of Object.entries(activeTrades)) {
          balances[addr] = {
            symbol: t.symbol || "",
            tokens_in_possession: t.tokens_in_possession,
            eth_spent: t.eth_spent,
            eth_sold: t.eth_sold || 0,
            current_eth_value: t.current_eth_value || 0,
          };
        }
        return sendJson(res, 200, {
          trades: balances,
          count: Object.keys(balances).length,
        });
      }

      // ── POST /pause ──────────────────────────────────────────
      if (method === "POST" && url === "/pause") {
        paused = true;
        log("[CONTROL] Auto-trading PAUSED (market data feed still running)");
        return sendJson(res, 200, { paused: true, message: "Auto-trading paused. Market data feed continues." });
      }

      // ── POST /resume ─────────────────────────────────────────
      if (method === "POST" && url === "/resume") {
        paused = false;
        log("[CONTROL] Auto-trading RESUMED");
        return sendJson(res, 200, { paused: false, message: "Auto-trading resumed." });
      }

      // ── POST /sell-all ───────────────────────────────────────
      if (method === "POST" && url === "/sell-all") {
        const pairs = Object.keys(activeTrades);
        if (pairs.length === 0) {
          return sendJson(res, 200, { message: "No active trades to sell.", results: [] });
        }
        log(`[CONTROL] SELL-ALL triggered for ${pairs.length} position(s)`);
        const results = await Promise.allSettled(
          pairs.map((addr) => {
            const trade = activeTrades[addr];
            if (!trade) return Promise.resolve({ pairAddress: addr, status: "skipped" });
            return executeSell(addr, trade, 100)
              .then(() => ({ pairAddress: addr, symbol: trade.symbol, status: "sold" }))
              .catch((e) => ({ pairAddress: addr, symbol: trade.symbol, status: "error", error: e.message }));
          })
        );
        return sendJson(res, 200, {
          message: `Sell-all executed for ${pairs.length} position(s)`,
          results: results.map((r) => r.value || { status: "rejected", reason: r.reason?.message }),
        });
      }

      // ── POST /sell ───────────────────────────────────────────
      if (method === "POST" && url === "/sell") {
        const body = await parseBody(req);
        const addr = (body.pairAddress || "").toLowerCase();
        const percent = parseFloat(body.percent || 100);

        if (!addr) return sendJson(res, 400, { error: "Missing pairAddress" });
        if (percent <= 0 || percent > 100) return sendJson(res, 400, { error: "percent must be 1-100" });

        const trade = activeTrades[addr];
        if (!trade) return sendJson(res, 404, { error: `No active trade for ${addr}` });

        if (executing[addr]) return sendJson(res, 409, { error: `Trade on ${addr} is already executing` });

        log(`[CONTROL] Manual SELL ${percent}% of ${trade.symbol || addr}`);
        await executeSell(addr, trade, percent);
        return sendJson(res, 200, {
          message: `Sell ${percent}% executed for ${trade.symbol || addr}`,
          pairAddress: addr,
          percent,
        });
      }

      // ── POST /buy ────────────────────────────────────────────
      if (method === "POST" && url === "/buy") {
        const body = await parseBody(req);
        const addr = (body.pairAddress || "").toLowerCase();
        const ethAmount = parseFloat(body.ethAmount || 0);

        if (!addr) return sendJson(res, 400, { error: "Missing pairAddress" });
        if (ethAmount <= 0) return sendJson(res, 400, { error: "ethAmount must be > 0" });

        if (activeTrades[addr]) return sendJson(res, 409, { error: `Already have an active trade on ${addr}` });
        if (executing[addr]) return sendJson(res, 409, { error: `Trade on ${addr} is already executing` });

        const pairData = computedPairData[addr];
        if (!pairData) return sendJson(res, 404, { error: `Pair ${addr} not found in market data. Wait for it to appear in the feed.` });

        // Compute actionPercent relative to maxEthPerTrade, capped at 100
        const actionPercent = Math.min(Math.round((ethAmount / config.maxEthPerTrade) * 100), 100);
        const actualEth = config.maxEthPerTrade * (actionPercent / 100);

        log(`[CONTROL] Manual BUY on ${pairData.symbol || addr} for ~${actualEth.toFixed(6)} ETH (action=${actionPercent}%)`);
        await executeBuy(addr, pairData, { id: "manual" }, actionPercent);
        return sendJson(res, 200, {
          message: `Buy executed for ${pairData.symbol || addr}`,
          pairAddress: addr,
          eth_amount: actualEth,
          action_percent: actionPercent,
        });
      }

      // ── GET /trades ──────────────────────────────────────────
      if (method === "GET" && url === "/trades") {
        const summary = computeSummary();

        const open = Object.entries(activeTrades).map(([addr, t]) => ({
          pairAddress: addr,
          symbol: t.symbol || "",
          policy_id: t.policy_id,
          entry_price: t.entry_price,
          current_price: t.current_price,
          price_change_pct: parseFloat((t.price_change_pct || 0).toFixed(2)),
          eth_spent: t.eth_spent,
          eth_sold: t.eth_sold || 0,
          current_eth_value: t.current_eth_value || 0,
          total_value: (t.eth_sold || 0) + (t.current_eth_value || 0),
          pnl_eth: parseFloat(((t.eth_sold || 0) + (t.current_eth_value || 0) - t.eth_spent).toFixed(6)),
          pnl_pct: t.eth_spent > 0 ? parseFloat((((t.eth_sold || 0) + (t.current_eth_value || 0) - t.eth_spent) / t.eth_spent * 100).toFixed(2)) : 0,
          tokens_bought: t.tokens_bought,
          tokens_in_possession: t.tokens_in_possession,
          tokens_sold: t.tokens_bought - t.tokens_in_possession,
          opened_at: t.opened_at,
          age_ms: Date.now() - (t.opened_at || Date.now()),
        }));

        const closed = inactiveTrades.map((t) => ({
          pairAddress: t.pairAddress,
          symbol: t.symbol || "",
          policy_id: t.policy_id,
          entry_price: t.entry_price,
          exit_price: t.exit_price || t.current_price,
          eth_spent: t.eth_spent,
          eth_sold: t.eth_sold || 0,
          pnl_eth: parseFloat(((t.eth_sold || 0) - t.eth_spent).toFixed(6)),
          pnl_pct: t.eth_spent > 0 ? parseFloat((((t.eth_sold || 0) - t.eth_spent) / t.eth_spent * 100).toFixed(2)) : 0,
          tokens_bought: t.tokens_bought,
          opened_at: t.opened_at,
          closed_at: t.closed_at,
          close_reason: t.close_reason || "policy_exit",
        }));

        return sendJson(res, 200, { summary, open_trades: open, closed_trades: closed });
      }

      // ── GET /config ──────────────────────────────────────────
      if (method === "GET" && url === "/config") {
        return sendJson(res, 200, config);
      }

      // ── POST /config ─────────────────────────────────────────
      if (method === "POST" && url === "/config") {
        const body = await parseBody(req);
        const updatable = ["maxEthPerTrade", "slippage", "maxPositions", "groupInterval", "maxGroups", "onlyPairs", "excludePairs"];
        const updated = {};
        for (const key of updatable) {
          if (body[key] !== undefined) {
            config[key] = body[key];
            updated[key] = body[key];
          }
        }
        if (Object.keys(updated).length > 0) {
          saveConfig(config);
          log(`[CONTROL] Config updated: ${JSON.stringify(updated)}`);
        }
        return sendJson(res, 200, { message: "Config updated", updated, config });
      }

      // ── 404 ──────────────────────────────────────────────────
      sendJson(res, 404, { error: `Unknown endpoint: ${method} ${url}` });
    } catch (err) {
      log(`[CONTROL] Error handling ${method} ${url}: ${err.message}`);
      sendJson(res, 500, { error: err.message });
    }
  });

  controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
    log(`[CONTROL] HTTP control server listening on http://127.0.0.1:${CONTROL_PORT}`);
  });

  controlServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`[CONTROL] Port ${CONTROL_PORT} in use. Control server disabled. Set CONTROL_PORT env to use a different port.`);
    } else {
      log(`[CONTROL] Server error: ${err.message}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 8: Main Entry Point
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("  Standalone Trading Agent — Base Chain");
  console.log("=".repeat(60));

  // Validate PRIVATE_KEY
  if (!PRIVATE_KEY) {
    console.error("\nError: PRIVATE_KEY environment variable is required.");
    console.error("Usage: PRIVATE_KEY=0x... node standalone-agent.js");
    console.error("\nOptional env vars:");
    console.error("  RPC_URL        — Base RPC endpoint (default: https://mainnet.base.org)");
    console.error("  CONFIG_PATH    — Path to agent-config.json (default: ./agent-config.json)");
    console.error("  SERVER_URL     — Market data server (default: https://alpha.cssgod.io)");
    console.error("  CONTROL_PORT   — HTTP control server port (default: 31415)");
    process.exit(1);
  }

  // Setup provider and wallet
  provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  log(`[INIT] Wallet: ${wallet.address}`);
  log(`[INIT] RPC:    ${RPC_URL}`);
  log(`[INIT] Server: ${SERVER_URL}`);
  log(`[INIT] Config: ${CONFIG_PATH}`);

  // Check ETH balance
  try {
    const balance = await provider.getBalance(wallet.address);
    const ethBalance = parseFloat(ethers.formatEther(balance));
    log(`[INIT] ETH Balance: ${ethBalance.toFixed(6)} ETH`);

    if (ethBalance < 0.001) {
      log("[INIT] WARNING: Very low ETH balance. You may not be able to execute trades.");
    }
  } catch (error) {
    log(`[INIT] Could not fetch balance: ${error.message}`);
  }

  // Log config summary
  log(`[INIT] Max ETH/trade: ${config.maxEthPerTrade}`);
  log(`[INIT] Slippage: ${config.slippage}%`);
  log(`[INIT] Max positions: ${config.maxPositions}`);
  log(`[INIT] Group interval: ${config.groupInterval} min`);
  log(`[INIT] Max groups/pair: ${config.maxGroups}`);
  const withEntry = config.policies.filter((p) => p.entryFunc).length;
  const withExit = config.policies.filter((p) => p.exitFunc).length;
  log(`[INIT] Policies: ${config.policies.length} (${withEntry} with entryFunc, ${withExit} with exitFunc)`);

  if (config.onlyPairs.length > 0) {
    log(`[INIT] Only pairs: ${config.onlyPairs.length}`);
  }
  if (config.excludePairs.length > 0) {
    log(`[INIT] Excluded pairs: ${config.excludePairs.length}`);
  }

  if (config.policies.length === 0) {
    log("[INIT] WARNING: No policies configured. The agent will track data but will not trade.");
    log("[INIT] Create an agent-config.json file with entryFunc/exitFunc policies to enable trading.");
  }

  // Load saved trades from previous session
  loadTrades();

  // Verify on-chain balances for restored trades (removes zero-balance trades, updates amounts)
  if (Object.keys(activeTrades).length > 0) {
    await checkTradeBalances();
  }

  // Connect to market data feed
  connectToFeed();

  // Start HTTP control server
  startControlServer();

  // Fetch initial gas price, then refresh every 30 seconds
  async function updateGasPrice() {
    try {
      const feeData = await provider.getFeeData();
      if (feeData?.gasPrice) {
        gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice, "gwei"));
      }
    } catch (e) { /* keep previous value */ }
  }
  await updateGasPrice();
  setInterval(updateGasPrice, 30000);

  // Cleanup interval (every 15 minutes)
  setInterval(cleanupOldGroups, 15 * 60 * 1000);

  // Periodic balance check (every 5 minutes) — prunes zero-balance trades, syncs amounts
  setInterval(checkTradeBalances, 5 * 60 * 1000);

  // Status logging interval (every 60 seconds)
  setInterval(() => {
    const pairCount = Object.keys(computedPairData).length;
    const tradeCount = Object.keys(activeTrades).length;

    let statusMsg = `[STATUS] Pairs: ${pairCount} | Active trades: ${tradeCount} | Updates: ${updateCount}`;

    // PnL summary for active trades
    if (tradeCount > 0) {
      let totalPnl = 0;
      for (const trade of Object.values(activeTrades)) {
        const pnlPct = trade.price_change_pct || 0;
        totalPnl += pnlPct;
        statusMsg += `\n  ${trade.symbol || trade.pairAddress}: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | ETH in: ${trade.eth_spent.toFixed(6)} | Est value: ${(trade.current_eth_value || 0).toFixed(6)}`;
      }
    }

    log(statusMsg);
    updateCount = 0; // Reset counter
    saveTrades();
  }, 60000);

  // SIGINT handler
  process.on("SIGINT", () => {
    log("\n[SHUTDOWN] Received SIGINT, shutting down...");

    if (Object.keys(activeTrades).length > 0) {
      log("[SHUTDOWN] Active trades:");
      for (const [addr, trade] of Object.entries(activeTrades)) {
        log(`  ${trade.symbol || addr}: PnL ${(trade.price_change_pct || 0).toFixed(2)}% | Tokens: ${trade.tokens_in_possession} | ETH in: ${trade.eth_spent.toFixed(6)}`);
      }
      log("[SHUTDOWN] WARNING: Active trades are NOT automatically closed. Manage them manually.");
    }

    saveTrades();
    if (controlServer) controlServer.close();
    if (socket) socket.disconnect();
    process.exit(0);
  });

  log("[INIT] Agent started. Waiting for market data...\n");
}

// Allow other scripts to require config helpers without running main()
module.exports = { loadConfig, saveConfig, loadTrades, saveTrades, checkTradeBalances, computeSummary, DEFAULT_CONFIG, CONFIG_PATH, TRADES_PATH, TRADE_LOG_PATH };

// Run main only when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
