/**
 * Spring Scanner — per-ticker optimized impulse detector.
 *
 * Алгоритм (из статистического анализа 3 мес. 1H данных):
 *   1. Объём нарастает N баров подряд (накапливается давление)
 *   2. Текущий бар пробивает ближайший уровень (свип) И закрывается обратно
 *   3. Объём на свип-баре ≥ volThresh × avg20
 *   4. IMOEX-фильтр по типу корреляции акции с индексом:
 *      - diverge: акция идёт ПРОТИВ IMOEX (аномалия — сильный сигнал)
 *      - aligned: акция идёт С IMOEX (моментум)
 *      - neutral: IMOEX стоит (независимое движение)
 *      - none:    без фильтра
 *
 * Параметры подобраны индивидуально для каждого тикера.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOrderBooks, prefetchFigis, type OrderBook } from "./tinkoff-invest";

// ── Per-ticker configuration ───────────────────────────────────────────────────

type ImoexFilter = "none" | "aligned" | "neutral" | "diverge";
type Direction   = "BUY" | "SELL" | "BOTH";

interface TickerConfig {
  volThresh:   number;      // min volume on sweep bar vs avg20
  growthBars:  number;      // min consecutive bars of rising volume before sweep
  dir:         Direction;   // allowed signal directions
  tp:          number;      // take-profit %
  sl:          number;      // stop-loss %
  imoexFilter: ImoexFilter; // which IMOEX context to require
  corr:        number;      // correlation with IMOEX (for message context)
  ev:          number;      // expected EV % per trade from backtest
}

const TICKER_CONFIG: Record<string, TickerConfig> = {
  CBOM:  { volThresh:1.2, growthBars:2, dir:"BUY",  tp:3,   sl:2,    imoexFilter:"diverge", corr:0.23, ev:2.40 },
  PLZL:  { volThresh:2.0, growthBars:2, dir:"SELL", tp:3,   sl:2,    imoexFilter:"diverge", corr:0.37, ev:2.25 },
  CHMF:  { volThresh:1.5, growthBars:3, dir:"SELL", tp:3,   sl:2,    imoexFilter:"none",    corr:0.62, ev:2.00 },
  ENPG:  { volThresh:1.5, growthBars:3, dir:"BUY",  tp:2,   sl:2,    imoexFilter:"diverge", corr:0.56, ev:2.00 },
  TATN:  { volThresh:2.5, growthBars:2, dir:"BUY",  tp:3,   sl:2,    imoexFilter:"diverge", corr:0.64, ev:2.00 },
  VKCO:  { volThresh:1.2, growthBars:2, dir:"SELL", tp:3,   sl:1,    imoexFilter:"aligned", corr:0.50, ev:2.00 },
  GMKN:  { volThresh:2.0, growthBars:3, dir:"BUY",  tp:2.5, sl:1.5,  imoexFilter:"diverge", corr:0.56, ev:1.88 },
  MAGN:  { volThresh:2.5, growthBars:2, dir:"SELL", tp:2.5, sl:1.5,  imoexFilter:"diverge", corr:0.58, ev:1.88 },
  LENT:  { volThresh:2.0, growthBars:2, dir:"BUY",  tp:2,   sl:2,    imoexFilter:"diverge", corr:0.43, ev:1.67 },
  RAGR:  { volThresh:2.5, growthBars:3, dir:"BOTH", tp:3,   sl:1,    imoexFilter:"none",    corr:0.39, ev:1.67 },
  ALRS:  { volThresh:1.5, growthBars:2, dir:"SELL", tp:1.5, sl:0.75, imoexFilter:"aligned", corr:0.55, ev:1.50 },
  OZON:  { volThresh:2.0, growthBars:3, dir:"BUY",  tp:3,   sl:0.75, imoexFilter:"none",    corr:0.51, ev:1.50 },
  WUSH:  { volThresh:1.5, growthBars:2, dir:"SELL", tp:2,   sl:2,    imoexFilter:"neutral", corr:0.40, ev:1.50 },
  AFKS:  { volThresh:2.5, growthBars:2, dir:"SELL", tp:3,   sl:1,    imoexFilter:"none",    corr:0.53, ev:1.40 },
  UGLD:  { volThresh:1.2, growthBars:3, dir:"BUY",  tp:3,   sl:2,    imoexFilter:"none",    corr:0.24, ev:1.40 },
  RENI:  { volThresh:1.2, growthBars:3, dir:"SELL", tp:2.5, sl:0.75, imoexFilter:"none",    corr:0.40, ev:1.35 },
  BSPB:  { volThresh:1.5, growthBars:2, dir:"SELL", tp:3,   sl:0.75, imoexFilter:"neutral", corr:0.45, ev:1.31 },
  MSNG:  { volThresh:1.2, growthBars:2, dir:"SELL", tp:1.5, sl:0.75, imoexFilter:"none",    corr:0.42, ev:1.29 },
  PHOR:  { volThresh:1.2, growthBars:3, dir:"BOTH", tp:3,   sl:1,    imoexFilter:"aligned", corr:0.56, ev:1.25 },
  T:     { volThresh:1.2, growthBars:3, dir:"BUY",  tp:3,   sl:0.75, imoexFilter:"diverge", corr:0.67, ev:1.25 },
  VTBR:  { volThresh:1.5, growthBars:3, dir:"SELL", tp:2.5, sl:1,    imoexFilter:"none",    corr:0.45, ev:1.10 },
  WUSH2: { volThresh:1.5, growthBars:2, dir:"SELL", tp:2,   sl:2,    imoexFilter:"neutral", corr:0.40, ev:1.09 },
  CBOM2: { volThresh:1.2, growthBars:2, dir:"BUY",  tp:3,   sl:2,    imoexFilter:"none",    corr:0.23, ev:1.27 },
  MDMG:  { volThresh:1.2, growthBars:2, dir:"SELL", tp:3,   sl:1.5,  imoexFilter:"none",    corr:0.45, ev:0.83 },
  VKCO2: { volThresh:1.2, growthBars:2, dir:"SELL", tp:3,   sl:1,    imoexFilter:"none",    corr:0.50, ev:0.82 },
  NLMK:  { volThresh:2.0, growthBars:2, dir:"BUY",  tp:1.5, sl:2,    imoexFilter:"none",    corr:0.61, ev:0.78 },
  SVCB:  { volThresh:1.2, growthBars:2, dir:"SELL", tp:1.5, sl:2,    imoexFilter:"none",    corr:0.50, ev:0.75 },
  IRAO:  { volThresh:2.0, growthBars:2, dir:"SELL", tp:3,   sl:0.75, imoexFilter:"none",    corr:0.53, ev:0.64 },
  HEAD:  { volThresh:2.0, growthBars:2, dir:"SELL", tp:1,   sl:2,    imoexFilter:"none",    corr:0.45, ev:0.60 },
  SNGS:  { volThresh:2.5, growthBars:2, dir:"SELL", tp:3,   sl:1.5,  imoexFilter:"none",    corr:0.60, ev:0.60 },
  GAZP:  { volThresh:1.2, growthBars:2, dir:"SELL", tp:1,   sl:1.5,  imoexFilter:"none",    corr:0.68, ev:0.56 },
  LKOH:  { volThresh:2.5, growthBars:3, dir:"BOTH", tp:2,   sl:2,    imoexFilter:"none",    corr:0.66, ev:0.50 },
  YDEX:  { volThresh:1.2, growthBars:3, dir:"BUY",  tp:1.5, sl:1.5,  imoexFilter:"none",    corr:0.64, ev:0.50 },
  X5:    { volThresh:1.2, growthBars:2, dir:"SELL", tp:2.5, sl:1.5,  imoexFilter:"none",    corr:0.49, ev:0.47 },
  CNRU:  { volThresh:1.5, growthBars:2, dir:"SELL", tp:1,   sl:2,    imoexFilter:"none",    corr:0.25, ev:0.44 },
  DOMRF: { volThresh:1.2, growthBars:3, dir:"SELL", tp:1,   sl:0.75, imoexFilter:"none",    corr:0.43, ev:0.42 },
  SBER:  { volThresh:2.5, growthBars:3, dir:"SELL", tp:2.5, sl:2,    imoexFilter:"none",    corr:0.48, ev:0.42 },
  MTSS:  { volThresh:1.2, growthBars:3, dir:"SELL", tp:1,   sl:0.75, imoexFilter:"none",    corr:0.40, ev:0.38 },
  ROSN:  { volThresh:1.2, growthBars:2, dir:"SELL", tp:1.5, sl:1.5,  imoexFilter:"none",    corr:0.61, ev:0.38 },
  SBERP: { volThresh:1.2, growthBars:2, dir:"SELL", tp:2,   sl:2,    imoexFilter:"none",    corr:0.49, ev:0.36 },
  MOEX:  { volThresh:2.5, growthBars:2, dir:"BUY",  tp:1.5, sl:2,    imoexFilter:"none",    corr:0.51, ev:0.36 },
  AFLT:  { volThresh:2.0, growthBars:2, dir:"SELL", tp:1,   sl:2,    imoexFilter:"diverge", corr:0.46, ev:0.40 },
  POSI:  { volThresh:2.5, growthBars:2, dir:"BUY",  tp:1.5, sl:2,    imoexFilter:"neutral", corr:0.44, ev:0.29 },
  TATNP: { volThresh:2.0, growthBars:2, dir:"SELL", tp:1.5, sl:2,    imoexFilter:"none",    corr:0.66, ev:1.00 },
  FLOT:  { volThresh:2.0, growthBars:3, dir:"BUY",  tp:1.5, sl:2,    imoexFilter:"none",    corr:0.43, ev:0.90 },
  NVTK:  { volThresh:1.5, growthBars:3, dir:"SELL", tp:1.5, sl:1.5,  imoexFilter:"none",    corr:0.65, ev:0.90 },
  RUAL:  { volThresh:2.5, growthBars:2, dir:"BUY",  tp:2,   sl:2,    imoexFilter:"none",    corr:0.56, ev:1.00 },
  SNGSP: { volThresh:2.5, growthBars:3, dir:"BUY",  tp:1.5, sl:2,    imoexFilter:"none",    corr:0.43, ev:1.00 },
  OZPH:  { volThresh:2.5, growthBars:2, dir:"SELL", tp:3,   sl:1,    imoexFilter:"none",    corr:0.37, ev:1.00 },
};

const DEFAULT_CONFIG: TickerConfig = {
  volThresh: 1.5, growthBars: 2, dir: "SELL", tp: 1.5, sl: 2,
  imoexFilter: "none", corr: 0.45, ev: 0,
};

function getConfig(ticker: string): TickerConfig {
  return TICKER_CONFIG[ticker] ?? DEFAULT_CONFIG;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type Candle = {
  timestamp: Date;
  open: number; high: number; low: number; close: number; volume: number;
};

export type EarlyMovementCandidate = {
  ticker:            string;
  direction:         "BUY" | "SELL";
  sweepBar:          { timestamp: Date; open: number; high: number; low: number; close: number };
  entryPrice:        number;
  takeProfit:        number;
  stopLoss:          number;
  targetPct:         number;
  stopPct:           number;
  // signal quality
  score:             number;      // 1–5 composite
  sweepDepthPct:     number;      // how deep the sweep went
  sweepVolumeRatio:  number;      // volume on sweep bar vs avg20
  volumeEscalation:  number;      // how many bars volume was rising
  // IMOEX context
  imoexTrendPct:     number;      // 3-bar IMOEX change
  imoexFilter:       ImoexFilter;
  imoexRelation:     string;      // human-readable relation
  // order book
  orderBookImbalance: number | null;
  marketOpen:        boolean;
  // backtest stats
  backtestEV:        number;      // expected EV % per trade from backtest
  backtestWR:        number;      // approximate WR from backtest config
};

export type EarlyMovementScan = {
  generatedAt:     Date;
  analyzedTickers: number;
  candidates:      EarlyMovementCandidate[];
};

// ── DB helpers ─────────────────────────────────────────────────────────────────

const HOUR_MS   = 60 * 60_000;
const HOUR_ROWS = 60;
const COOLDOWN_HOURS = 6;
const MAX_CANDIDATES = 7;
const MINUTE_1_MS = 60_000;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgArr(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function parseCandle(row: Record<string, unknown>): Candle | null {
  const ts = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
  const open = num(row.open), high = num(row.high), low = num(row.low),
        close = num(row.close), volume = num(row.volume);
  if (!Number.isFinite(ts.getTime()) || open === null || high === null ||
      low === null || close === null || volume === null ||
      high < low || close <= 0) return null;
  return { timestamp: ts, open, high, low, close, volume };
}

async function loadHourlyCandles(
  now: Date,
): Promise<{ tickers: Map<string, Candle[]>; imoex: Candle[] }> {
  const result = await db.execute(sql`
    SELECT ticker, timestamp, open, high, low, close, volume
    FROM (
      SELECT ticker, timestamp, open, high, low, close, volume,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles
      WHERE timeframe = '1h' AND ticker NOT IN ('XAUUSD','XAGUSD','BRENT')
    ) t WHERE rn <= ${HOUR_ROWS}
    ORDER BY ticker, timestamp
  `);

  const tickers = new Map<string, Candle[]>();
  const imoexArr: Candle[] = [];

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const ticker = String(row.ticker ?? "");
    const candle  = parseCandle(row);
    if (!ticker || !candle) continue;
    if (ticker === "IMOEX") {
      imoexArr.push(candle);
    } else {
      const arr = tickers.get(ticker) ?? [];
      arr.push(candle);
      tickers.set(ticker, arr);
    }
  }

  const cutoff = now.getTime();
  for (const [t, bars] of tickers) {
    tickers.set(t, bars.filter((b) => b.timestamp.getTime() + HOUR_MS <= cutoff));
  }
  return {
    tickers,
    imoex: imoexArr.filter((b) => b.timestamp.getTime() + HOUR_MS <= cutoff),
  };
}

async function loadLatestPrices(now: Date): Promise<Map<string, { price: number; timestamp: Date }>> {
  const result = await db.execute(sql`
    SELECT ticker, close, timestamp
    FROM (
      SELECT ticker, close, timestamp,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles WHERE timeframe='1m' AND ticker NOT IN ('IMOEX','XAUUSD','XAGUSD','BRENT')
    ) t WHERE rn = 1
  `);
  const prices = new Map<string, { price: number; timestamp: Date }>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const price = num(row.close);
    const ts = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
    if (!price || price <= 0 || !Number.isFinite(ts.getTime())) continue;
    if (now.getTime() - (ts.getTime() + MINUTE_1_MS) < 60 * 60_000) {
      prices.set(String(row.ticker), { price, timestamp: ts });
    }
  }
  return prices;
}

async function loadCooldownSet(now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - COOLDOWN_HOURS * HOUR_MS);
  const result = await db.execute(sql`
    SELECT DISTINCT ticker || ':' || direction AS key
    FROM signals_history
    WHERE metadata ->> 'source' = 'movement' AND generated_at >= ${since}
  `);
  const keys = new Set<string>();
  for (const raw of result.rows) {
    const k = String((raw as Record<string, unknown>).key ?? "");
    if (k) keys.add(k);
  }
  return keys;
}

// ── IMOEX helpers ──────────────────────────────────────────────────────────────

function imoexTrend3h(imoex: Candle[]): number {
  if (imoex.length < 4) return 0;
  const last = imoex.at(-1)!, prev = imoex.at(-4)!;
  return prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
}

function checkImoexFilter(filter: ImoexFilter, imoexPct: number, dir: "BUY" | "SELL"): boolean {
  if (filter === "none") return true;
  if (filter === "aligned") {
    return dir === "BUY" ? imoexPct > 0.2 : imoexPct < -0.2;
  }
  if (filter === "neutral") {
    return Math.abs(imoexPct) <= 0.3;
  }
  if (filter === "diverge") {
    // акция идёт ПРОТИВ IMOEX — аномалия
    return dir === "BUY" ? imoexPct < -0.2 : imoexPct > 0.2;
  }
  return true;
}

function imoexRelationText(filter: ImoexFilter, imoexPct: number, dir: "BUY" | "SELL"): string {
  const pctStr = `${imoexPct >= 0 ? "+" : ""}${imoexPct.toFixed(2)}%`;
  if (filter === "diverge") {
    return dir === "BUY"
      ? `аномалия: акция откупают, пока IMOEX падает (${pctStr})`
      : `аномалия: акцию продают, пока IMOEX растёт (${pctStr})`;
  }
  if (filter === "aligned") {
    return dir === "BUY"
      ? `моментум: IMOEX тоже растёт (${pctStr}), акция в потоке`
      : `моментум: IMOEX падает (${pctStr}), акция следует`;
  }
  if (filter === "neutral") {
    return `IMOEX стоит на месте (${pctStr}) — акция движется самостоятельно`;
  }
  return `IMOEX ${pctStr} за 3 часа`;
}

// ── Detection ──────────────────────────────────────────────────────────────────

function countVolumeGrowth(bars: Candle[], upToIdx: number): number {
  // Считаем сколько баров подряд объём нарастает, заканчивая на bars[upToIdx]
  let count = 0;
  for (let i = upToIdx; i > 0; i--) {
    if (bars[i].volume > bars[i - 1].volume) count++;
    else break;
  }
  return count;
}

function detectCandidate(
  ticker:       string,
  bars:         Candle[],
  imoexPct:     number,
  book:         OrderBook | null,
  latestPrice:  { price: number; timestamp: Date } | undefined,
  cooldown:     Set<string>,
): EarlyMovementCandidate | null {
  const cfg = getConfig(ticker);
  if (bars.length < 10) return null;

  // The sweep bar is the most recent closed bar
  const swIdx = bars.length - 1;
  const sw = bars[swIdx]!;

  // Volume baseline: avg of up to 20 bars before sweep bar
  const volBars = bars.slice(Math.max(0, swIdx - 20), swIdx);
  const avg20   = avgArr(volBars.map((b) => b.volume));
  if (avg20 <= 0) return null;

  const swVolRatio = sw.volume / avg20;
  if (swVolRatio < cfg.volThresh) return null;

  // Volume escalation: must be rising for growthBars consecutive bars ending at swIdx
  const escalation = countVolumeGrowth(bars, swIdx);
  if (escalation < cfg.growthBars) return null;

  // Reference range: last 5 bars before sweep bar
  const ref = bars.slice(Math.max(0, swIdx - 5), swIdx);
  if (ref.length < 3) return null;
  const refHigh = Math.max(...ref.map((b) => b.high));
  const refLow  = Math.min(...ref.map((b) => b.low));

  const swRange    = sw.high - sw.low;
  if (swRange <= 0) return null;
  const closeLoc   = (sw.close - sw.low) / swRange; // 0=bottom, 1=top

  const marketOpen    = book?.marketOpen ?? false;
  const bidImbalance  = book?.bidImbalance ?? null;

  // ── Try LONG: sweep below refLow, bullish rejection close ────────────────
  if ((cfg.dir === "BUY" || cfg.dir === "BOTH") && !cooldown.has(`${ticker}:BUY`)) {
    if (sw.low < refLow && closeLoc >= 0.55) {
      const sweepDepthPct = (refLow - sw.low) / refLow * 100;
      if (!checkImoexFilter(cfg.imoexFilter, imoexPct, "BUY")) return null;

      let score = 1;
      if (swVolRatio >= 2.0)                                            score++;
      if (escalation >= 3)                                              score++;
      if (marketOpen && bidImbalance !== null && bidImbalance >= 0.55)  score++;
      if (sweepDepthPct >= 0.3)                                         score++;

      const entry = latestPrice?.price ?? sw.close;
      const tp = cfg.tp, sl = cfg.sl;
      return {
        ticker, direction: "BUY",
        sweepBar: { timestamp: sw.timestamp, open: sw.open, high: sw.high, low: sw.low, close: sw.close },
        entryPrice: entry,
        takeProfit: entry * (1 + tp / 100),
        stopLoss:   entry * (1 - sl / 100),
        targetPct: tp, stopPct: sl,
        score, sweepDepthPct, sweepVolumeRatio: swVolRatio, volumeEscalation: escalation,
        imoexTrendPct: imoexPct, imoexFilter: cfg.imoexFilter,
        imoexRelation: imoexRelationText(cfg.imoexFilter, imoexPct, "BUY"),
        orderBookImbalance: bidImbalance, marketOpen,
        backtestEV: cfg.ev,
        backtestWR: cfg.ev > 0 ? Math.round(50 + cfg.ev * 8) : 50,
      };
    }
  }

  // ── Try SHORT: sweep above refHigh, bearish rejection close ──────────────
  if ((cfg.dir === "SELL" || cfg.dir === "BOTH") && !cooldown.has(`${ticker}:SELL`)) {
    if (sw.high > refHigh && closeLoc <= 0.45) {
      const sweepDepthPct = (sw.high - refHigh) / refHigh * 100;
      if (!checkImoexFilter(cfg.imoexFilter, imoexPct, "SELL")) return null;

      let score = 1;
      if (swVolRatio >= 2.0)                                            score++;
      if (escalation >= 3)                                              score++;
      if (marketOpen && bidImbalance !== null && bidImbalance <= 0.45)  score++;
      if (sweepDepthPct >= 0.3)                                         score++;

      const entry = latestPrice?.price ?? sw.close;
      const tp = cfg.tp, sl = cfg.sl;
      return {
        ticker, direction: "SELL",
        sweepBar: { timestamp: sw.timestamp, open: sw.open, high: sw.high, low: sw.low, close: sw.close },
        entryPrice: entry,
        takeProfit: entry * (1 - tp / 100),
        stopLoss:   entry * (1 + sl / 100),
        targetPct: tp, stopPct: sl,
        score, sweepDepthPct, sweepVolumeRatio: swVolRatio, volumeEscalation: escalation,
        imoexTrendPct: imoexPct, imoexFilter: cfg.imoexFilter,
        imoexRelation: imoexRelationText(cfg.imoexFilter, imoexPct, "SELL"),
        orderBookImbalance: bidImbalance, marketOpen,
        backtestEV: cfg.ev,
        backtestWR: cfg.ev > 0 ? Math.round(50 + cfg.ev * 8) : 50,
      };
    }
  }

  return null;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function scanEarlyMovement(): Promise<EarlyMovementScan> {
  const now = new Date();

  const [{ tickers: hourlyMap, imoex }, cooldown] = await Promise.all([
    loadHourlyCandles(now),
    loadCooldownSet(now),
  ]);

  const activeTickers = [...hourlyMap.keys()].sort();

  void prefetchFigis(activeTickers).catch(() => {});

  const [bookMap, latestPrices] = await Promise.all([
    getOrderBooks(activeTickers).catch(() => new Map<string, OrderBook>()),
    loadLatestPrices(now).catch(() => new Map<string, { price: number; timestamp: Date }>()),
  ]);

  const imoexPct = imoexTrend3h(imoex);

  const candidates: EarlyMovementCandidate[] = [];
  for (const ticker of activeTickers) {
    const bars = hourlyMap.get(ticker);
    if (!bars || bars.length < 10) continue;
    const book   = bookMap.get(ticker) ?? null;
    const latest = latestPrices.get(ticker);
    const c = detectCandidate(ticker, bars, imoexPct, book, latest, cooldown);
    if (c) candidates.push(c);
  }

  candidates.sort((a, b) => b.score - a.score || b.sweepVolumeRatio - a.sweepVolumeRatio);

  return {
    generatedAt:     now,
    analyzedTickers: activeTickers.length,
    candidates:      candidates.slice(0, MAX_CANDIDATES),
  };
}
