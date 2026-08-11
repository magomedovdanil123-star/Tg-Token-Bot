/**
 * Alpha Scanner — combined strategy.
 *
 * Runs two independent signal sources every scan cycle and returns their
 * candidates in a single result:
 *
 *   1. Improved Retest/Reclaim (MTS-Alpha):
 *      - Original 1H setup (≥2 of 3: volume ≥2×, 3h momentum ≤−0.3%, bearish body)
 *      - Adverse pullback ≥ 0.7% against the SHORT
 *      - Closed 5m impulse confirmation: bearish, closes below previous low,
 *        body ≥ 45% of range, close in lower 38% of range, volume ≥ 1.2× prior 20 bars
 *      - Confirmation not older than 20 minutes
 *      - Ticker cooldown: no repeated alpha signal within 12 hours
 *      - Entry at fresh 1m close price; TP/SL ±1.5%
 *
 *   2. Smart Money (IMOEX universe, same filters as the main Smart Money scanner)
 *
 * Smart Money is NOT changed — this file calls scanSmartMoney as-is.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  scanSmartMoney,
  type SmartMoneyCandidate,
} from "./smart-money-scanner";

export type AlphaRetestCandidate = {
  ticker: string;
  direction: "SELL";
  candleTimestamp: Date;
  confirmationTimestamp: Date;
  setupPrice: number;
  pullbackPercent: number;
  volumeRatio: number;
  bodyRatio: number;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  targetPercent: number;
  stopPercent: number;
  score: number;
};

export type AlphaScan = {
  generatedAt: Date;
  analyzedRetest: number;
  retestCandidates: AlphaRetestCandidate[];
  smartMoneyCandidates: SmartMoneyCandidate[];
};

const PULLBACK_PERCENT = 0.7;   // adversarial move before confirmation
const VOLUME_RATIO   = 1.2;    // minimum volume vs prior 20 bars
const BODY_RATIO_MIN = 0.45;   // impulse candle minimum body/range
const CLOSE_LOC_MIN  = 0.62;   // impulse close must be in lower 38%
const CONFIRMATION_MAX_AGE_MS = 20 * 60_000;
const COOLDOWN_HOURS = 12;
const TARGET_PERCENT = 1.5;
const STOP_PERCENT   = 1.5;
const MINUTE_5_MS    = 5 * 60_000;
const HOUR_MS        = 60 * 60_000;
const HOUR_ROWS      = 80;
const MINUTE_ROWS    = 720; // ~12 hours of 1m data

type Candle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(values: number[]): number | null {
  return values.length
    ? values.reduce((s, v) => s + v, 0) / values.length
    : null;
}

function aggregate5m(rows: Candle[], now: Date): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.timestamp.getTime() / MINUTE_5_MS) * MINUTE_5_MS;
    const g = groups.get(bucket) ?? [];
    g.push(row);
    groups.set(bucket, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([b]) => b + MINUTE_5_MS <= now.getTime())
    .map(([b, g]) => ({
      timestamp: new Date(b),
      open:  g[0].open,
      high:  Math.max(...g.map((r) => r.high)),
      low:   Math.min(...g.map((r) => r.low)),
      close: g.at(-1)!.close,
      volume: g.reduce((s, r) => s + r.volume, 0),
    }));
}

function parseCandle(row: Record<string, unknown>): Candle | null {
  const timestamp =
    row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
  const open  = num(row.open);
  const high  = num(row.high);
  const low   = num(row.low);
  const close = num(row.close);
  const volume = num(row.volume);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    open === null || high === null || low === null ||
    close === null || volume === null ||
    close <= 0 || high < low
  ) return null;
  return { timestamp, open, high, low, close, volume };
}

async function loadHourlyRows(): Promise<Map<string, Candle[]>> {
  const result = await db.execute(sql`
    SELECT ticker, timestamp, open, high, low, close, volume
    FROM (
      SELECT
        ticker, timestamp, open, high, low, close, volume,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles
      WHERE timeframe = '1h'
        AND ticker IN (
          SELECT secid
          FROM moex_tickers
          WHERE is_active = true
            AND board_id = 'TQBR'
            AND secid <> 'IMOEX'
        )
    ) t WHERE rn <= ${HOUR_ROWS}
    ORDER BY ticker, timestamp
  `);
  const out = new Map<string, Candle[]>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const ticker = String(row.ticker ?? "");
    const candle = parseCandle(row);
    if (!ticker || !candle) continue;
    const arr = out.get(ticker) ?? [];
    arr.push(candle);
    out.set(ticker, arr);
  }
  return out;
}

async function loadMinuteRows(): Promise<Map<string, Candle[]>> {
  const result = await db.execute(sql`
    SELECT ticker, timestamp, open, high, low, close, volume
    FROM (
      SELECT
        ticker, timestamp, open, high, low, close, volume,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles
      WHERE timeframe = '1m'
        AND ticker IN (
          SELECT secid
          FROM moex_tickers
          WHERE is_active = true
            AND board_id = 'TQBR'
            AND secid <> 'IMOEX'
        )
    ) t WHERE rn <= ${MINUTE_ROWS}
    ORDER BY ticker, timestamp
  `);
  const out = new Map<string, Candle[]>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const ticker = String(row.ticker ?? "");
    const candle = parseCandle(row);
    if (!ticker || !candle) continue;
    const arr = out.get(ticker) ?? [];
    arr.push(candle);
    out.set(ticker, arr);
  }
  return out;
}

async function loadLatestPrices(): Promise<Map<string, { price: number; timestamp: Date }>> {
  const result = await db.execute(sql`
    SELECT ticker, close, timestamp
    FROM (
      SELECT ticker, close, timestamp,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
      FROM candles
      WHERE timeframe = '1m'
        AND ticker IN (
          SELECT secid
          FROM moex_tickers
          WHERE is_active = true
            AND board_id = 'TQBR'
            AND secid <> 'IMOEX'
        )
    ) t WHERE rn = 1
  `);
  const prices = new Map<string, { price: number; timestamp: Date }>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const price = num(row.close);
    const timestamp =
      row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
    if (price === null || price <= 0 || !Number.isFinite(timestamp.getTime())) continue;
    prices.set(String(row.ticker), { price, timestamp });
  }
  return prices;
}

async function loadCooldownTickers(now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - COOLDOWN_HOURS * HOUR_MS);
  const result = await db.execute(sql`
    SELECT DISTINCT ticker
    FROM signals_history
    WHERE metadata ->> 'source' = 'alpha'
      AND generated_at >= ${since}
  `);
  const tickers = new Set<string>();
  for (const raw of result.rows) {
    const ticker = String((raw as Record<string, unknown>).ticker ?? "");
    if (ticker) tickers.add(ticker);
  }
  return tickers;
}

function retestCandidateFor(
  ticker: string,
  hourRows: Candle[],
  minuteRows: Candle[],
  latestPrices: Map<string, { price: number; timestamp: Date }>,
  cooldownTickers: Set<string>,
  now: Date,
): AlphaRetestCandidate | null {
  if (cooldownTickers.has(ticker)) return null;

  const closed = hourRows.filter(
    (r) => r.timestamp.getTime() + HOUR_MS <= now.getTime(),
  );
  if (closed.length < 36) return null;

  const latest = latestPrices.get(ticker);
  if (!latest) return null;
  const priceAge = now.getTime() - (latest.timestamp.getTime() + 60_000);
  if (!Number.isFinite(priceAge) || priceAge < -5 * 60_000 || priceAge > CONFIRMATION_MAX_AGE_MS) {
    return null;
  }

  const bars5m = aggregate5m(minuteRows, now);
  if (bars5m.length < 10) return null;

  // Last 12 scored 1H setup candidates.
  const setupCandidates = closed
    .map((c, i) => {
      const av = avg(closed.slice(Math.max(0, i - 20), i).map((r) => r.volume));
      const c3 = closed[i - 3];
      const range = c.high - c.low;
      const bodyPos = range > 0 ? (c.close - c.open) / range : 0;
      const relVol = av && av > 0 ? c.volume / av : 0;
      const mom = c3 && c3.close > 0 ? c.close / c3.close - 1 : 0;
      const score =
        Number(relVol >= 2) +
        Number(mom <= -0.003) +
        Number(c.close < c.open && bodyPos <= -0.25);
      return { candle: c, score };
    })
    .filter(({ score }) => score >= 2)
    .slice(-12)
    .reverse();

  for (const setup of setupCandidates) {
    const setupEnd = setup.candle.timestamp.getTime() + HOUR_MS;
    const setupPrice = setup.candle.close;
    const adversePrice = setupPrice * (1 + PULLBACK_PERCENT / 100);

    const afterSetup = bars5m.filter(
      (b) => b.timestamp.getTime() + MINUTE_5_MS > setupEnd &&
             b.timestamp.getTime() + MINUTE_5_MS <= now.getTime(),
    );

    let pullbackSeen = false;
    for (let i = 0; i < afterSetup.length; i++) {
      const cur = afterSetup[i];
      if (!pullbackSeen) {
        if (cur.high >= adversePrice) pullbackSeen = true;
        continue;
      }
      if (i === 0) continue;
      const prev = afterSetup[i - 1];
      const range = Math.max(cur.high - cur.low, cur.close * 0.0001);
      const bodyRatio  = Math.abs(cur.close - cur.open) / range;
      const closeLoc   = (cur.high - cur.close) / range;
      const priorBars  = bars5m.filter((b) => b.timestamp.getTime() < cur.timestamp.getTime());
      const volBase    = avg(priorBars.slice(-20).map((b) => b.volume));
      const volumeRatio = volBase && volBase > 0 ? cur.volume / volBase : 0;

      const isImpulse =
        cur.close < cur.open &&
        cur.close < prev.low &&
        bodyRatio  >= BODY_RATIO_MIN &&
        closeLoc   >= CLOSE_LOC_MIN &&
        volumeRatio >= VOLUME_RATIO;

      if (!isImpulse) continue;

      const confirmEnd = new Date(cur.timestamp.getTime() + MINUTE_5_MS);
      const confirmAge = now.getTime() - confirmEnd.getTime();
      if (confirmAge < 0 || confirmAge > CONFIRMATION_MAX_AGE_MS) continue;

      const entryPrice = latest.price > 0 ? latest.price : cur.close;
      return {
        ticker,
        direction: "SELL",
        candleTimestamp: setup.candle.timestamp,
        confirmationTimestamp: confirmEnd,
        setupPrice,
        pullbackPercent: PULLBACK_PERCENT,
        volumeRatio,
        bodyRatio,
        entryPrice,
        takeProfit: entryPrice * (1 - TARGET_PERCENT / 100),
        stopLoss:   entryPrice * (1 + STOP_PERCENT   / 100),
        targetPercent: TARGET_PERCENT,
        stopPercent:   STOP_PERCENT,
        score: setup.score,
      };
    }
  }
  return null;
}

export async function scanAlphaStrategy(): Promise<AlphaScan> {
  const generatedAt = new Date();

  const [hourlyRows, minuteRows, latestPrices, cooldownTickers, smScan] =
    await Promise.all([
      loadHourlyRows(),
      loadMinuteRows(),
      loadLatestPrices(),
      loadCooldownTickers(generatedAt),
      scanSmartMoney(undefined, { universe: "imoex", source: "smartmoney" }),
    ]);

  const retestCandidates: AlphaRetestCandidate[] = [];
  for (const [ticker, rows] of hourlyRows) {
    const candidate = retestCandidateFor(
      ticker,
      rows,
      minuteRows.get(ticker) ?? [],
      latestPrices,
      cooldownTickers,
      generatedAt,
    );
    if (candidate) retestCandidates.push(candidate);
  }

  retestCandidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.candleTimestamp.getTime() - b.candleTimestamp.getTime(),
  );

  return {
    generatedAt,
    analyzedRetest: hourlyRows.size,
    retestCandidates: retestCandidates.slice(0, 5),
    smartMoneyCandidates: smScan.candidates,
  };
}
