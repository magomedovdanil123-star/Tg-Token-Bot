import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ReplitDirection = "BUY" | "SELL";

export type ReplitCandidate = {
  ticker: string;
  direction: ReplitDirection;
  candleTimestamp: Date;
  executionTimestamp: Date;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  targetPercent: number;
  stopPercent: number;
  score: number;
};

export type ReplitScan = {
  generatedAt: Date;
  analyzed: number;
  candidates: ReplitCandidate[];
};

const TARGET_PERCENT = 1;
const STOP_PERCENT = 0.75;
const MIN_SCORE = 5;
const MIN_VALIDATED_OCCURRENCES = 100;

type HourCandle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function ema(values: number[], period: number) {
  if (values.length < period) return null;
  const seed = average(values.slice(0, period));
  if (seed === null) return null;
  const multiplier = 2 / (period + 1);
  let current = seed;
  for (const value of values.slice(period)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

function parseCandle(row: Record<string, unknown>): HourCandle | null {
  const timestamp =
    row.timestamp instanceof Date
      ? row.timestamp
      : new Date(String(row.timestamp));
  const open = number(row.open);
  const high = number(row.high);
  const low = number(row.low);
  const close = number(row.close);
  const volume = number(row.volume);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    close <= 0 ||
    high < low
  ) {
    return null;
  }
  return { timestamp, open, high, low, close, volume };
}

async function loadHourlyRows() {
  const result = await db.execute(sql`
    SELECT ticker, timestamp, open, high, low, close, volume
    FROM (
      SELECT
        ticker, timestamp, open, high, low, close, volume,
        ROW_NUMBER() OVER (
          PARTITION BY ticker
          ORDER BY timestamp DESC
        ) AS row_number
      FROM candles
      WHERE timeframe = '1h'
        AND ticker IN (
          SELECT secid
          FROM moex_tickers
          WHERE is_active = true
            AND secid <> 'IMOEX'
        )
    ) recent
    WHERE row_number <= 80
    ORDER BY ticker, timestamp
  `);
  const byTicker = new Map<string, HourCandle[]>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const ticker = String(row.ticker ?? "");
    const candle = parseCandle(row);
    if (!ticker || !candle) continue;
    const rows = byTicker.get(ticker) ?? [];
    rows.push(candle);
    byTicker.set(ticker, rows);
  }
  return byTicker;
}

async function loadLatestPrices() {
  const result = await db.execute(sql`
    SELECT ticker, close, timestamp
    FROM (
      SELECT
        ticker, close, timestamp,
        ROW_NUMBER() OVER (
          PARTITION BY ticker
          ORDER BY timestamp DESC
        ) AS row_number
      FROM candles
      WHERE timeframe = '1m'
        AND ticker IN (
          SELECT secid
          FROM moex_tickers
          WHERE is_active = true
            AND secid <> 'IMOEX'
        )
    ) recent
    WHERE row_number = 1
  `);
  const prices = new Map<string, { price: number; timestamp: Date }>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const price = number(row.close);
    const timestamp =
      row.timestamp instanceof Date
        ? row.timestamp
        : new Date(String(row.timestamp));
    if (
      price === null ||
      price <= 0 ||
      !Number.isFinite(timestamp.getTime())
    ) {
      continue;
    }
    prices.set(String(row.ticker), { price, timestamp });
  }
  return prices;
}

async function hasValidatedEvidence() {
  const result = await db.execute(sql`
    SELECT 1
    FROM feature_combinations
    WHERE is_active = true
      AND name = 'replit:mts'
      AND statistical_significance = true
      AND occurrences >= ${MIN_VALIDATED_OCCURRENCES}
      AND COALESCE(test_expected_value, 0) > 0
      AND COALESCE(test_profit_factor, 0) > 1
    LIMIT 1
  `);
  return result.rows.length > 0;
}

function currentOneMinutePrice(
  ticker: string,
  latestPrices: Map<string, { price: number; timestamp: Date }>,
  fallback: number,
  now: Date,
) {
  const latest = latestPrices.get(ticker);
  if (!latest) return null;
  const ageMs = now.getTime() - (latest.timestamp.getTime() + 60_000);
  if (!Number.isFinite(ageMs) || ageMs < -5 * 60_000 || ageMs > 20 * 60_000) {
    return null;
  }
  return latest.price > 0 ? latest.price : fallback;
}

function candidateFor(
  ticker: string,
  rows: HourCandle[],
  latestPrices: Map<string, { price: number; timestamp: Date }>,
  now: Date,
): ReplitCandidate | null {
  const closed = rows.filter(
    (row) => row.timestamp.getTime() + 60 * 60_000 <= now.getTime(),
  );
  if (closed.length < 36) return null;

  const current = closed.at(-1);
  if (!current) return null;
  const currentAgeMs =
    now.getTime() - (current.timestamp.getTime() + 60 * 60_000);
  if (
    !Number.isFinite(currentAgeMs) ||
    currentAgeMs < -5 * 60_000 ||
    currentAgeMs > 3 * 60 * 60_000
  ) {
    return null;
  }
  const closes = closed.map((row) => row.close);
  const ema10 = ema(closes, 10);
  const ema30 = ema(closes, 30);
  const prior = closed.slice(-13, -1);
  const priorHigh = Math.max(...prior.map((row) => row.high));
  const priorLow = Math.min(...prior.map((row) => row.low));
  const averageVolume = average(
    closed.slice(-21, -1).map((row) => row.volume),
  );
  const threeHoursAgo = closed.at(-4);
  const range = current.high - current.low;
  const bodyPosition =
    range > 0 ? (current.close - current.open) / range : 0;
  const relativeVolume =
    averageVolume && averageVolume > 0
      ? current.volume / averageVolume
      : 0;
  const momentum =
    threeHoursAgo && threeHoursAgo.close > 0
      ? current.close / threeHoursAgo.close - 1
      : 0;
  if (
    ema10 === null ||
    ema30 === null ||
    averageVolume === null ||
    !Number.isFinite(momentum)
  ) {
    return null;
  }

  const longScore = [
    ema10 > ema30,
    current.close > ema10,
    momentum >= 0.0035,
    relativeVolume >= 1.3,
    current.close > current.open && bodyPosition >= 0.55,
    current.close > priorHigh,
  ].filter(Boolean).length;
  const shortScore = [
    ema10 < ema30,
    current.close < ema10,
    momentum <= -0.0035,
    relativeVolume >= 1.3,
    current.close < current.open && bodyPosition <= -0.55,
    current.close < priorLow,
  ].filter(Boolean).length;
  const direction =
    longScore >= MIN_SCORE
      ? "BUY"
      : shortScore >= MIN_SCORE
        ? "SELL"
        : null;
  const score = Math.max(longScore, shortScore);
  if (!direction) return null;

  const entryPrice = currentOneMinutePrice(
    ticker,
    latestPrices,
    current.close,
    now,
  );
  if (entryPrice === null) return null;
  const takeProfit =
    direction === "BUY"
      ? entryPrice * (1 + TARGET_PERCENT / 100)
      : entryPrice * (1 - TARGET_PERCENT / 100);
  const stopLoss =
    direction === "BUY"
      ? entryPrice * (1 - STOP_PERCENT / 100)
      : entryPrice * (1 + STOP_PERCENT / 100);
  return {
    ticker,
    direction,
    candleTimestamp: current.timestamp,
    executionTimestamp: latestPrices.get(ticker)?.timestamp ?? current.timestamp,
    entryPrice,
    takeProfit,
    stopLoss,
    targetPercent: TARGET_PERCENT,
    stopPercent: STOP_PERCENT,
    score,
  };
}

export async function scanReplitStrategy(): Promise<ReplitScan> {
  const generatedAt = new Date();
  // The rule set is intentionally fail-closed. The archive currently has no
  // statistically significant positive out-of-sample
  // MTS combination after costs, so do not emit attractive-looking but losing
  // signals until this strategy itself has a validated combination.
  if (!(await hasValidatedEvidence())) {
    return { generatedAt, analyzed: 0, candidates: [] };
  }
  const [hourlyRows, latestPrices] = await Promise.all([
    loadHourlyRows(),
    loadLatestPrices(),
  ]);
  const candidates: ReplitCandidate[] = [];
  for (const [ticker, rows] of hourlyRows) {
    const candidate = candidateFor(ticker, rows, latestPrices, generatedAt);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.candleTimestamp.getTime() - right.candleTimestamp.getTime(),
  );
  return {
    generatedAt,
    analyzed: hourlyRows.size,
    candidates: candidates.slice(0, 5),
  };
}