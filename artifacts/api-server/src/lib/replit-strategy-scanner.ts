import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ReplitDirection = "BUY" | "SELL";

export type ReplitCandidate = {
  ticker: string;
  direction: ReplitDirection;
  candleTimestamp: Date;
  executionTimestamp: Date;
  confirmationTimestamp: Date;
  setupPrice: number;
  pullbackPercent: number;
  confirmationVolumeRatio: number;
  confirmationBodyRatio: number;
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

const TARGET_PERCENT = 1.5;
const STOP_PERCENT = 1.5;
const EXPERIMENTAL_SCORE = 2;
const RETEST_PULLBACK_PERCENT = 0.5;
const RETEST_VOLUME_RATIO = 1.2;
const RETEST_CONFIRMATION_MAX_AGE_MS = 20 * 60_000;
const MINUTE_HISTORY_ROWS = 720;

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

function aggregate15m(rows: HourCandle[], now: Date) {
  const groups = new Map<number, HourCandle[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.timestamp.getTime() / (15 * 60_000)) * 15 * 60_000;
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([bucket]) => bucket + 15 * 60_000 <= now.getTime())
    .map(([bucket, group]) => ({
      timestamp: new Date(bucket),
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, row) => sum + row.volume, 0),
    }));
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

async function loadMinuteRows() {
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
      WHERE timeframe = '1m'
        AND ticker IN (
          SELECT secid
          FROM moex_tickers
          WHERE is_active = true
            AND secid <> 'IMOEX'
        )
    ) recent
    WHERE row_number <= ${MINUTE_HISTORY_ROWS}
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
  minuteRows: HourCandle[],
  latestPrices: Map<string, { price: number; timestamp: Date }>,
  now: Date,
): ReplitCandidate | null {
  const closed = rows.filter(
    (row) => row.timestamp.getTime() + 60 * 60_000 <= now.getTime(),
  );
  if (closed.length < 36) return null;

  const minute15 = aggregate15m(minuteRows, now);
  if (minute15.length < 25) return null;

  // Keep the original 1H setup, but do not enter on the setup candle.
  // A later 15m reclaim must first prove that price moved against the setup
  // and then returned with a directional body and volume.
  const setupCandidates = closed
    .map((current, index) => {
      const averageVolume = average(
        closed.slice(Math.max(0, index - 20), index).map((row) => row.volume),
      );
      const threeHoursAgo = closed[index - 3];
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
      const shortScore = [
        relativeVolume >= 2,
        momentum <= -0.003,
        current.close < current.open && bodyPosition <= -0.25,
      ].filter(Boolean).length;
      return {
        current,
        index,
        shortScore,
      };
    })
    .filter(({ shortScore }) => shortScore >= EXPERIMENTAL_SCORE)
    .slice(-12);

  for (const setup of setupCandidates.reverse()) {
    const direction: ReplitDirection = "SELL";
    const setupEnd = setup.current.timestamp.getTime() + 60 * 60_000;
    const setupPrice = setup.current.close;
    const adversePrice =
      setupPrice * (1 + RETEST_PULLBACK_PERCENT / 100);
    const afterSetup = minute15.filter(
      (row) =>
        row.timestamp.getTime() + 15 * 60_000 > setupEnd &&
        row.timestamp.getTime() + 15 * 60_000 <= now.getTime(),
    );
    let pullbackSeen = false;
    for (let index = 0; index < afterSetup.length; index += 1) {
      const current = afterSetup[index];
      if (!pullbackSeen) {
        if (current.high >= adversePrice) pullbackSeen = true;
        continue;
      }
      const previous = afterSetup[index - 1];
      const range = Math.max(current.high - current.low, current.close * 0.0001);
      const bodyRatio =
        Math.abs(current.close - current.open) / range;
      const closeLocation = (current.high - current.close) / range;
      const priorBars = minute15.filter(
        (row) => row.timestamp.getTime() < current.timestamp.getTime(),
      );
      const volumeBaseline = average(
        priorBars.slice(-20).map((row) => row.volume),
      );
      const volumeRatio =
        volumeBaseline && volumeBaseline > 0
          ? current.volume / volumeBaseline
          : 0;
      const impulse =
        current.close < current.open &&
        current.close < previous.low &&
        bodyRatio >= 0.45 &&
        closeLocation >= 0.62 &&
        volumeRatio >= RETEST_VOLUME_RATIO;
      if (!impulse) continue;
      const confirmationTimestamp = new Date(
        current.timestamp.getTime() + 15 * 60_000,
      );
      const confirmationAgeMs =
        now.getTime() - confirmationTimestamp.getTime();
      if (
        confirmationAgeMs < 0 ||
        confirmationAgeMs > RETEST_CONFIRMATION_MAX_AGE_MS
      ) {
        continue;
      }
      const entryPrice = currentOneMinutePrice(
        ticker,
        latestPrices,
        current.close,
        now,
      );
      if (entryPrice === null) return null;
      const takeProfit = entryPrice * (1 - TARGET_PERCENT / 100);
      const stopLoss = entryPrice * (1 + STOP_PERCENT / 100);
      return {
        ticker,
        direction,
        candleTimestamp: setup.current.timestamp,
        executionTimestamp: latestPrices.get(ticker)?.timestamp ?? current.timestamp,
        confirmationTimestamp,
        setupPrice,
        pullbackPercent: RETEST_PULLBACK_PERCENT,
        confirmationVolumeRatio: volumeRatio,
        confirmationBodyRatio: bodyRatio,
        entryPrice,
        takeProfit,
        stopLoss,
        targetPercent: TARGET_PERCENT,
        stopPercent: STOP_PERCENT,
        score: setup.shortScore,
      };
    }
  }
  return null;
}

export async function scanReplitStrategy(): Promise<ReplitScan> {
  const generatedAt = new Date();
  const [hourlyRows, latestPrices, minuteRows] = await Promise.all([
    loadHourlyRows(),
    loadLatestPrices(),
    loadMinuteRows(),
  ]);
  const candidates: ReplitCandidate[] = [];
  for (const [ticker, rows] of hourlyRows) {
    const candidate = candidateFor(
      ticker,
      rows,
      minuteRows.get(ticker) ?? [],
      latestPrices,
      generatedAt,
    );
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