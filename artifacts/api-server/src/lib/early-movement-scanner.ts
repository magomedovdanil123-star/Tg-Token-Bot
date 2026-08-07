/**
 * Early Movement Scanner — 1H sweep-and-reversal detector.
 *
 * Detects the beginning of a directional move on 1-hour candles for ALL
 * active MOEX tickers (~70+).
 *
 * ── LONG setup (from X5 pattern analysis) ───────────────────────────────────
 *  1. Sweep: bar[-2].low < min(low, bars[-7..-3])        — pierces support
 *  2. Rejection: bar[-2] closes in upper 40% of its range  — bullish rejection
 *  3. Confirmation: bar[-1].low > bar[-2].low              — higher low
 *
 *  Score bonuses (each +1):
 *   + bar[-1].close > max(high, bars[-7..-3])             — range breakout
 *   + bar[-2].volume ≥ 1.3 × avg20                        — sweep on volume
 *   + order book bid imbalance ≥ 0.55 (when market open)  — buyer dominance
 *   + IMOEX 3-bar change ≥ −0.8%                          — index not bearish
 *
 * ── SHORT setup (from ALRS / X5 reversal pattern) ───────────────────────────
 *  1. Sweep: bar[-2].high > max(high, bars[-7..-3])       — pierces resistance
 *  2. Rejection: bar[-2] closes in lower 40%              — bearish rejection
 *  3. Confirmation: bar[-1].high < bar[-2].high            — lower high
 *
 *  Score bonuses (each +1):
 *   + bar[-1].close < min(low, bars[-7..-3])              — range breakdown
 *   + bar[-2].volume ≥ 1.3 × avg20
 *   + order book bid imbalance ≤ 0.45 (seller dominance)
 *   + IMOEX 3-bar change ≤ +0.8%
 *
 * Minimum score to emit a signal: 2.
 * Cooldown: 8 h per ticker per direction.
 * TP/SL: ±2 % from entry.
 * Top 7 candidates sorted by score desc, then by recency.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOrderBooks, prefetchFigis, type OrderBook } from "./tinkoff-invest";

// ── Constants ─────────────────────────────────────────────────────────────────

const HOUR_MS          = 60 * 60_000;
const HOUR_ROWS        = 60;          // bars loaded per ticker
const SWEEP_MIN_PCT    = 0.15;        // minimum meaningful sweep depth %
const REJECTION_LOC    = 0.40;        // close must be beyond this fraction from the sweep side
const VOLUME_RATIO_MIN = 1.3;         // sweep bar volume vs avg20
const OB_BID_LONG_MIN  = 0.55;        // bid imbalance threshold for LONG bonus
const OB_BID_SHORT_MAX = 0.45;        // bid imbalance threshold for SHORT bonus
const IMOEX_TREND_PCT  = 0.8;         // IMOEX 3-bar change limit for direction filter
const COOLDOWN_HOURS   = 8;
const TARGET_PCT       = 2.0;
const STOP_PCT         = 2.0;
const MIN_SCORE        = 2;
const MAX_CANDIDATES   = 7;
const MINUTE_1_MS      = 60_000;

// ── Types ─────────────────────────────────────────────────────────────────────

type Candle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type EarlyMovementCandidate = {
  ticker: string;
  direction: "BUY" | "SELL";
  sweepBar: { timestamp: Date; open: number; high: number; low: number; close: number };
  confirmBar: { timestamp: Date; open: number; high: number; low: number; close: number };
  sweepDepthPct: number;
  sweepVolumeRatio: number;
  imoexTrendPct: number;
  orderBookImbalance: number | null;  // null = market closed
  marketOpen: boolean;
  rangeBreakout: boolean;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  targetPct: number;
  stopPct: number;
  score: number;  // 1 (base) + up to 4 bonuses
};

export type EarlyMovementScan = {
  generatedAt: Date;
  analyzedTickers: number;
  candidates: EarlyMovementCandidate[];
};

// ── DB helpers ────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function parseCandle(row: Record<string, unknown>): Candle | null {
  const ts = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
  const open  = num(row.open);
  const high  = num(row.high);
  const low   = num(row.low);
  const close = num(row.close);
  const volume = num(row.volume);
  if (
    !Number.isFinite(ts.getTime()) ||
    open === null || high === null || low === null ||
    close === null || volume === null ||
    high < low || close <= 0
  ) return null;
  return { timestamp: ts, open, high, low, close, volume };
}

// Non-MOEX instruments stored in the candles table — exclude from equity scan.
const EXCLUDED_TICKERS = new Set(["IMOEX", "XAUUSD", "XAGUSD", "BRENT"]);

async function loadHourlyCandles(
  now: Date,
): Promise<{ tickers: Map<string, Candle[]>; imoex: Candle[] }> {
  const result = await db.execute(sql`
    SELECT ticker, timestamp, open, high, low, close, volume
    FROM (
      SELECT
        ticker, timestamp, open, high, low, close, volume,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles
      WHERE timeframe = '1h'
        AND ticker NOT IN ('XAUUSD', 'XAGUSD', 'BRENT')
    ) t WHERE rn <= ${HOUR_ROWS}
    ORDER BY ticker, timestamp
  `);

  const tickers = new Map<string, Candle[]>();
  const imoexArr: Candle[] = [];

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const ticker = String(row.ticker ?? "");
    const candle = parseCandle(row);
    if (!ticker || !candle) continue;
    if (ticker === "IMOEX") {
      imoexArr.push(candle);
    } else if (!EXCLUDED_TICKERS.has(ticker)) {
      const arr = tickers.get(ticker) ?? [];
      arr.push(candle);
      tickers.set(ticker, arr);
    }
  }

  // Keep only rows for which the 1H bar is fully closed
  const cutoff = now.getTime();
  for (const [t, bars] of tickers) {
    tickers.set(
      t,
      bars.filter((b) => b.timestamp.getTime() + HOUR_MS <= cutoff),
    );
  }
  const imoexClosed = imoexArr.filter(
    (b) => b.timestamp.getTime() + HOUR_MS <= cutoff,
  );

  return { tickers, imoex: imoexClosed };
}

async function loadLatestPrices(
  now: Date,
): Promise<Map<string, { price: number; timestamp: Date }>> {
  const result = await db.execute(sql`
    SELECT ticker, close, timestamp
    FROM (
      SELECT ticker, close, timestamp,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles
      WHERE timeframe = '1m'
        AND ticker NOT IN ('IMOEX', 'XAUUSD', 'XAGUSD', 'BRENT')
    ) t WHERE rn = 1
  `);
  const prices = new Map<string, { price: number; timestamp: Date }>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const price = num(row.close);
    const ts = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
    if (price === null || price <= 0 || !Number.isFinite(ts.getTime())) continue;
    // Accept 1m price only if it's not older than 60 minutes
    const age = now.getTime() - (ts.getTime() + MINUTE_1_MS);
    if (age < 60 * 60_000) {
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
    WHERE metadata ->> 'source' = 'movement'
      AND generated_at >= ${since}
  `);
  const keys = new Set<string>();
  for (const raw of result.rows) {
    const k = String((raw as Record<string, unknown>).key ?? "");
    if (k) keys.add(k);
  }
  return keys;
}

// Derives the ticker list directly from the candle map — no separate DB query needed.

// ── Detection logic ───────────────────────────────────────────────────────────

function imoexTrend(imoex: Candle[]): number {
  // 3-bar change: (imoex[-1].close - imoex[-4].close) / imoex[-4].close * 100
  if (imoex.length < 4) return 0;
  const last = imoex.at(-1)!;
  const prev = imoex.at(-4)!;
  if (prev.close <= 0) return 0;
  return (last.close - prev.close) / prev.close * 100;
}

function detectCandidate(
  ticker: string,
  bars: Candle[],
  imoexPct: number,
  book: OrderBook | null,
  latestPrice: { price: number; timestamp: Date } | undefined,
  cooldown: Set<string>,
): EarlyMovementCandidate | null {
  // Need at least 9 bars: 5 reference + 1 avg reference + sweep + confirm + margin
  if (bars.length < 9) return null;

  const sweepBar  = bars.at(-2)!;
  const confirmBar = bars.at(-1)!;
  const refBars   = bars.slice(-7, -2); // bars[-7..-3] — 5 reference bars

  if (refBars.length < 3) return null;

  const refHigh = Math.max(...refBars.map((b) => b.high));
  const refLow  = Math.min(...refBars.map((b) => b.low));

  // Volume baseline: avg of bars before sweep bar (up to 20)
  const volBars = bars.slice(-22, -2);
  const avgVol  = avg(volBars.map((b) => b.volume));
  const volRatio = avgVol && avgVol > 0 ? sweepBar.volume / avgVol : 0;

  const sweepRange = sweepBar.high - sweepBar.low;
  if (sweepRange <= 0) return null;

  const marketOpen = book?.marketOpen ?? false;
  const bidImbalance = book?.bidImbalance ?? null;

  // ── Try LONG ─────────────────────────────────────────────────────────────
  const longCooldownKey = `${ticker}:BUY`;
  if (!cooldown.has(longCooldownKey)) {
    const sweptBelow = sweepBar.low < refLow;
    if (sweptBelow) {
      const sweepDepthPct = (refLow - sweepBar.low) / refLow * 100;
      const closeLoc = (sweepBar.close - sweepBar.low) / sweepRange; // 0=bottom, 1=top
      const bullishRejection = closeLoc >= (1 - REJECTION_LOC);      // closes in upper 40%
      const higherLow = confirmBar.low > sweepBar.low;

      if (sweepDepthPct >= SWEEP_MIN_PCT && bullishRejection && higherLow) {
        let score = 1;
        const rangeBreakout = confirmBar.close > refHigh;
        if (rangeBreakout) score++;
        if (volRatio >= VOLUME_RATIO_MIN) score++;
        if (marketOpen && bidImbalance !== null && bidImbalance >= OB_BID_LONG_MIN) score++;
        if (imoexPct >= -IMOEX_TREND_PCT) score++;

        if (score >= MIN_SCORE) {
          const entry = latestPrice?.price ?? confirmBar.close;
          return {
            ticker,
            direction: "BUY",
            sweepBar: { timestamp: sweepBar.timestamp, open: sweepBar.open, high: sweepBar.high, low: sweepBar.low, close: sweepBar.close },
            confirmBar: { timestamp: confirmBar.timestamp, open: confirmBar.open, high: confirmBar.high, low: confirmBar.low, close: confirmBar.close },
            sweepDepthPct,
            sweepVolumeRatio: volRatio,
            imoexTrendPct: imoexPct,
            orderBookImbalance: bidImbalance,
            marketOpen,
            rangeBreakout,
            entryPrice: entry,
            takeProfit: entry * (1 + TARGET_PCT / 100),
            stopLoss:   entry * (1 - STOP_PCT   / 100),
            targetPct: TARGET_PCT,
            stopPct:   STOP_PCT,
            score,
          };
        }
      }
    }
  }

  // ── Try SHORT ────────────────────────────────────────────────────────────
  const shortCooldownKey = `${ticker}:SELL`;
  if (!cooldown.has(shortCooldownKey)) {
    const sweptAbove = sweepBar.high > refHigh;
    if (sweptAbove) {
      const sweepDepthPct = (sweepBar.high - refHigh) / refHigh * 100;
      const closeLoc = (sweepBar.close - sweepBar.low) / sweepRange;
      const bearishRejection = closeLoc <= REJECTION_LOC;               // closes in lower 40%
      const lowerHigh = confirmBar.high < sweepBar.high;

      if (sweepDepthPct >= SWEEP_MIN_PCT && bearishRejection && lowerHigh) {
        let score = 1;
        const rangeBreakdown = confirmBar.close < refLow;
        if (rangeBreakdown) score++;
        if (volRatio >= VOLUME_RATIO_MIN) score++;
        if (marketOpen && bidImbalance !== null && bidImbalance <= OB_BID_SHORT_MAX) score++;
        if (imoexPct <= IMOEX_TREND_PCT) score++;

        if (score >= MIN_SCORE) {
          const entry = latestPrice?.price ?? confirmBar.close;
          return {
            ticker,
            direction: "SELL",
            sweepBar: { timestamp: sweepBar.timestamp, open: sweepBar.open, high: sweepBar.high, low: sweepBar.low, close: sweepBar.close },
            confirmBar: { timestamp: confirmBar.timestamp, open: confirmBar.open, high: confirmBar.high, low: confirmBar.low, close: confirmBar.close },
            sweepDepthPct,
            sweepVolumeRatio: volRatio,
            imoexTrendPct: imoexPct,
            orderBookImbalance: bidImbalance,
            marketOpen,
            rangeBreakout: rangeBreakdown,
            entryPrice: entry,
            takeProfit: entry * (1 - TARGET_PCT / 100),
            stopLoss:   entry * (1 + STOP_PCT   / 100),
            targetPct: TARGET_PCT,
            stopPct:   STOP_PCT,
            score,
          };
        }
      }
    }
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scanEarlyMovement(): Promise<EarlyMovementScan> {
  const now = new Date();

  const [{ tickers: hourlyMap, imoex }, cooldown] = await Promise.all([
    loadHourlyCandles(now),
    loadCooldownSet(now),
  ]);

  // Derive ticker list from loaded candles — covers IMOEX + 2nd-tier + manual additions.
  const activeTickers = [...hourlyMap.keys()].sort();

  // Prefetch FIGIs (no-op if cache is fresh)
  void prefetchFigis(activeTickers).catch(() => {});

  // Fetch order books and latest prices in parallel
  const [bookMap, latestPrices] = await Promise.all([
    getOrderBooks(activeTickers).catch(() => new Map<string, OrderBook>()),
    loadLatestPrices(now).catch(() => new Map<string, { price: number; timestamp: Date }>()),
  ]);

  const imoexPct = imoexTrend(imoex);

  const candidates: EarlyMovementCandidate[] = [];
  for (const ticker of activeTickers) {
    const bars = hourlyMap.get(ticker);
    if (!bars || bars.length < 9) continue;
    const book = bookMap.get(ticker) ?? null;
    const latest = latestPrices.get(ticker);
    const c = detectCandidate(ticker, bars, imoexPct, book, latest, cooldown);
    if (c) candidates.push(c);
  }

  // Sort: higher score first, then more recent sweep bar
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.sweepBar.timestamp.getTime() - a.sweepBar.timestamp.getTime(),
  );

  return {
    generatedAt: now,
    analyzedTickers: activeTickers.length,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}
