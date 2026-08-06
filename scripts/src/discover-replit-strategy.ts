import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

type Candle = {
  ticker: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Feature = Candle & {
  index: number;
  previousHigh12: number | null;
  previousLow12: number | null;
  previousHigh24: number | null;
  previousLow24: number | null;
  averageVolume20: number | null;
  averageRange20: number | null;
  ma10: number | null;
  ma30: number | null;
  relativeVolume: number | null;
  bodyPosition: number;
  momentum3: number | null;
  trend10To30: number | null;
  marketRegime: "BULL" | "BEAR" | "NEUTRAL" | null;
  train: boolean;
};

type Signal = {
  ticker: string;
  index: number;
  timestamp: Date;
  direction: "BUY" | "SELL";
  pattern: string;
};

type Stats = {
  pattern: string;
  direction: "BUY" | "SELL";
  takeProfit: number;
  stopLoss: number;
  horizonBars: number;
  total: number;
  wins: number;
  sum: number;
  positive: number;
  negative: number;
  trainTotal: number;
  trainWins: number;
  trainSum: number;
  trainPositive: number;
  trainNegative: number;
  testTotal: number;
  testWins: number;
  testSum: number;
  testPositive: number;
  testNegative: number;
  maxDrawdown: number;
};

type OutcomeCache = Map<string, number | null>;

const TIMEFRAME = "1h";
const TRAIN_CUTOFF = new Date("2026-01-01T00:00:00.000Z");
const COST_PERCENT = 0.1;
const COOLDOWN_BARS = 12;
const HORIZONS = [6, 12, 24];
const TAKE_PROFITS = [0.5, 0.75, 1, 1.5];
const STOP_LOSSES = [0.5, 0.75, 1, 1.5];
const MIN_TOTAL = 100;
const MIN_TRAIN = 70;
const MIN_TEST = 30;

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function rollingAverage(values: number[], start: number, end: number) {
  if (start < 0 || end < start) return null;
  return average(values.slice(start, end + 1));
}

function max(values: number[], start: number, end: number) {
  if (start < 0 || end < start) return null;
  return Math.max(...values.slice(start, end + 1));
}

function min(values: number[], start: number, end: number) {
  if (start < 0 || end < start) return null;
  return Math.min(...values.slice(start, end + 1));
}

async function loadCandles() {
  const result = await db.execute(sql`
    SELECT c.ticker, c.timestamp, c.open, c.high, c.low, c.close, c.volume
    FROM candles c
    INNER JOIN moex_tickers u
      ON u.secid = c.ticker
      AND u.is_active = true
    WHERE c.timeframe = ${TIMEFRAME}
      AND c.ticker <> 'IMOEX'
    ORDER BY c.ticker, c.timestamp
  `);
  const groups = new Map<string, Candle[]>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const open = finite(row.open);
    const high = finite(row.high);
    const low = finite(row.low);
    const close = finite(row.close);
    const volume = finite(row.volume);
    const timestamp = new Date(String(row.timestamp));
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      close <= 0 ||
      !Number.isFinite(timestamp.getTime())
    ) {
      continue;
    }
    const candle = {
      ticker: String(row.ticker),
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    };
    const rows = groups.get(candle.ticker) ?? [];
    rows.push(candle);
    groups.set(candle.ticker, rows);
  }
  return groups;
}

async function loadMarketRegimes() {
  const result = await db.execute(sql`
    SELECT timestamp, close
    FROM candles
    WHERE ticker = 'IMOEX'
      AND timeframe = '1h'
    ORDER BY timestamp
  `);
  const rows = result.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      const timestamp =
        row.timestamp instanceof Date
          ? row.timestamp
          : new Date(String(row.timestamp));
      const close = finite(row.close);
      return Number.isFinite(timestamp.getTime()) && close !== null
        ? { timestamp, close }
        : null;
    })
    .filter((row): row is { timestamp: Date; close: number } => row !== null);
  const regimes = new Map<string, "BULL" | "BEAR" | "NEUTRAL">();
  for (let index = 29; index < rows.length; index += 1) {
    const current = rows[index];
    const ma10 = average(rows.slice(index - 9, index + 1).map((row) => row.close));
    const ma30 = average(rows.slice(index - 29, index + 1).map((row) => row.close));
    if (ma10 === null || ma30 === null) continue;
    const regime =
      current.close > ma10 && ma10 > ma30
        ? "BULL"
        : current.close < ma10 && ma10 < ma30
          ? "BEAR"
          : "NEUTRAL";
    regimes.set(current.timestamp.toISOString(), regime);
  }
  return regimes;
}

function buildFeatures(
  rows: Candle[],
  marketRegimes: Map<string, "BULL" | "BEAR" | "NEUTRAL">,
) {
  const volumes = rows.map((row) => row.volume);
  const ranges = rows.map((row) => row.high - row.low);
  const closes = rows.map((row) => row.close);
  const highs = rows.map((row) => row.high);
  const lows = rows.map((row) => row.low);
  const features: Feature[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const range = row.high - row.low;
    const averageVolume20 = rollingAverage(volumes, index - 20, index - 1);
    const ma10 = rollingAverage(closes, index - 9, index);
    const ma30 = rollingAverage(closes, index - 29, index);
    features.push({
      ...row,
      index,
      previousHigh12: max(highs, index - 12, index - 1),
      previousLow12: min(lows, index - 12, index - 1),
      previousHigh24: max(highs, index - 24, index - 1),
      previousLow24: min(lows, index - 24, index - 1),
      averageVolume20,
      averageRange20: rollingAverage(ranges, index - 20, index - 1),
      ma10,
      ma30,
      relativeVolume: averageVolume20
        ? row.volume / averageVolume20
        : null,
      bodyPosition: range > 0 ? (row.close - row.open) / range : 0,
      momentum3:
        index >= 3 && closes[index - 3] > 0
          ? row.close / closes[index - 3] - 1
          : null,
      trend10To30:
        ma10 !== null &&
        ma30 !== null
          ? ma10 / ma30 - 1
          : null,
      marketRegime: marketRegimes.get(row.timestamp.toISOString()) ?? null,
      train: row.timestamp < TRAIN_CUTOFF,
    });
  }
  return features;
}

function addSignal(
  signals: Signal[],
  feature: Feature,
  pattern: string,
  direction: "BUY" | "SELL",
) {
  signals.push({
    ticker: feature.ticker,
    index: feature.index,
    timestamp: feature.timestamp,
    direction,
    pattern,
  });
}

function detectSignals(rows: Feature[]) {
  const signals: Signal[] = [];
  for (const row of rows) {
    if (
      row.relativeVolume !== null &&
      row.bodyPosition >= 0.5 &&
      row.relativeVolume >= 1.2
    ) {
      addSignal(signals, row, "volume_bull_1.2", "BUY");
    }
    if (
      row.relativeVolume !== null &&
      row.bodyPosition <= -0.5 &&
      row.relativeVolume >= 1.2
    ) {
      addSignal(signals, row, "volume_bear_1.2", "SELL");
    }
    for (const threshold of [1.5, 2]) {
      if (
        row.relativeVolume !== null &&
        row.bodyPosition >= 0.5 &&
        row.relativeVolume >= threshold
      ) {
        addSignal(signals, row, `volume_bull_${threshold}`, "BUY");
      }
      if (
        row.relativeVolume !== null &&
        row.bodyPosition <= -0.5 &&
        row.relativeVolume >= threshold
      ) {
        addSignal(signals, row, `volume_bear_${threshold}`, "SELL");
      }
    }
    if (
      row.previousHigh12 !== null &&
      row.close > row.previousHigh12 &&
      row.bodyPosition >= 0.5
    ) {
      addSignal(signals, row, "breakout_high_12", "BUY");
    }
    if (
      row.previousLow12 !== null &&
      row.close < row.previousLow12 &&
      row.bodyPosition <= -0.5
    ) {
      addSignal(signals, row, "breakout_low_12", "SELL");
    }
    if (
      row.previousHigh24 !== null &&
      row.close > row.previousHigh24 &&
      row.bodyPosition >= 0.5
    ) {
      addSignal(signals, row, "breakout_high_24", "BUY");
    }
    if (
      row.previousLow24 !== null &&
      row.close < row.previousLow24 &&
      row.bodyPosition <= -0.5
    ) {
      addSignal(signals, row, "breakout_low_24", "SELL");
    }
    if (
      row.previousLow12 !== null &&
      row.low < row.previousLow12 &&
      row.close > row.previousLow12 &&
      row.bodyPosition >= 0.25
    ) {
      addSignal(signals, row, "liquidity_sweep_low_12", "BUY");
    }
    if (
      row.previousHigh12 !== null &&
      row.high > row.previousHigh12 &&
      row.close < row.previousHigh12 &&
      row.bodyPosition <= -0.25
    ) {
      addSignal(signals, row, "liquidity_sweep_high_12", "SELL");
    }
    if (
      row.previousLow24 !== null &&
      row.low < row.previousLow24 &&
      row.close > row.previousLow24 &&
      row.bodyPosition >= 0.25
    ) {
      addSignal(signals, row, "liquidity_sweep_low_24", "BUY");
    }
    if (
      row.previousHigh24 !== null &&
      row.high > row.previousHigh24 &&
      row.close < row.previousHigh24 &&
      row.bodyPosition <= -0.25
    ) {
      addSignal(signals, row, "liquidity_sweep_high_24", "SELL");
    }
    for (const tolerance of [0.002, 0.005, 0.01]) {
      if (
        row.previousLow24 !== null &&
        row.low <= row.previousLow24 * (1 + tolerance) &&
        row.bodyPosition >= 0.5 &&
        row.close > (row.ma10 ?? Number.POSITIVE_INFINITY)
      ) {
        addSignal(signals, row, `support_bounce_${tolerance}`, "BUY");
      }
      if (
        row.previousHigh24 !== null &&
        row.high >= row.previousHigh24 * (1 - tolerance) &&
        row.bodyPosition <= -0.5 &&
      row.close < (row.ma10 ?? Number.NEGATIVE_INFINITY) &&
      row.marketRegime !== null &&
      row.marketRegime !== "BEAR"
      ) {
        addSignal(signals, row, `resistance_reject_${tolerance}`, "SELL");
      }
      if (
        row.ma10 !== null &&
        row.ma30 !== null &&
        row.ma10 > row.ma30 &&
        row.low <= row.ma10 * (1 + tolerance) &&
        row.close > row.ma10 &&
        row.bodyPosition >= 0.25
      ) {
        addSignal(signals, row, `trend_pullback_long_${tolerance}`, "BUY");
      }
      if (
        row.ma10 !== null &&
        row.ma30 !== null &&
        row.ma10 < row.ma30 &&
        row.high >= row.ma10 * (1 - tolerance) &&
        row.close < row.ma10 &&
        row.bodyPosition <= -0.25
      ) {
        addSignal(signals, row, `trend_pullback_short_${tolerance}`, "SELL");
      }
    }
    for (const threshold of [1.2, 1.5, 2]) {
      if (
        row.relativeVolume !== null &&
        row.momentum3 !== null &&
        row.relativeVolume >= threshold &&
        row.momentum3 >= 0.003 &&
        row.bodyPosition >= 0.25
      ) {
        addSignal(signals, row, `momentum_volume_long_${threshold}`, "BUY");
      }
      if (
        row.relativeVolume !== null &&
        row.momentum3 !== null &&
        row.relativeVolume >= threshold &&
        row.momentum3 <= -0.003 &&
        row.bodyPosition <= -0.25
      ) {
        addSignal(signals, row, `momentum_volume_short_${threshold}`, "SELL");
      }
    }
    if (
      row.trend10To30 !== null &&
      row.previousHigh12 !== null &&
      row.relativeVolume !== null &&
      row.trend10To30 >= 0.002 &&
      row.relativeVolume >= 1.2 &&
      row.close > row.previousHigh12 &&
      row.bodyPosition >= 0.25
    ) {
      addSignal(signals, row, "trend_breakout_long", "BUY");
    }
    if (
      row.trend10To30 !== null &&
      row.previousLow12 !== null &&
      row.relativeVolume !== null &&
      row.trend10To30 <= -0.002 &&
      row.relativeVolume >= 1.2 &&
      row.close < row.previousLow12 &&
      row.bodyPosition <= -0.25
    ) {
      addSignal(signals, row, "trend_breakout_short", "SELL");
    }
  }
  return signals;
}

function evaluate(
  rows: Feature[],
  signal: Signal,
  takeProfit: number,
  stopLoss: number,
  horizonBars: number,
) {
  const entry = rows[signal.index]?.close;
  if (!entry) return null;
  const target =
    signal.direction === "BUY"
      ? entry * (1 + takeProfit / 100)
      : entry * (1 - takeProfit / 100);
  const stop =
    signal.direction === "BUY"
      ? entry * (1 - stopLoss / 100)
      : entry * (1 + stopLoss / 100);
  const last = Math.min(rows.length - 1, signal.index + horizonBars);
  for (let index = signal.index + 1; index <= last; index += 1) {
    const row = rows[index];
    const stopHit =
      signal.direction === "BUY" ? row.low <= stop : row.high >= stop;
    const targetHit =
      signal.direction === "BUY" ? row.high >= target : row.low <= target;
    if (stopHit) return -stopLoss - COST_PERCENT;
    if (targetHit) return takeProfit - COST_PERCENT;
  }
  const lastClose = rows[last]?.close;
  if (!lastClose) return null;
  const timeout =
    signal.direction === "BUY"
      ? (lastClose / entry - 1) * 100
      : (1 - lastClose / entry) * 100;
  return timeout - COST_PERCENT;
}

function updateStats(stats: Stats, value: number, train: boolean) {
  stats.total += 1;
  stats.sum += value;
  if (value > 0) {
    stats.wins += 1;
    stats.positive += value;
  } else {
    stats.negative += value;
  }
  if (train) {
    stats.trainTotal += 1;
    stats.trainSum += value;
    if (value > 0) {
      stats.trainWins += 1;
      stats.trainPositive += value;
    } else {
      stats.trainNegative += value;
    }
  } else {
    stats.testTotal += 1;
    stats.testSum += value;
    if (value > 0) {
      stats.testWins += 1;
      stats.testPositive += value;
    } else {
      stats.testNegative += value;
    }
  }
}

function mergeStats(target: Stats, source: Stats) {
  target.total += source.total;
  target.wins += source.wins;
  target.sum += source.sum;
  target.positive += source.positive;
  target.negative += source.negative;
  target.trainTotal += source.trainTotal;
  target.trainWins += source.trainWins;
  target.trainSum += source.trainSum;
  target.trainPositive += source.trainPositive;
  target.trainNegative += source.trainNegative;
  target.testTotal += source.testTotal;
  target.testWins += source.testWins;
  target.testSum += source.testSum;
  target.testPositive += source.testPositive;
  target.testNegative += source.testNegative;
  target.maxDrawdown = Math.max(target.maxDrawdown, source.maxDrawdown);
}

function statsFor(
  pattern: string,
  direction: "BUY" | "SELL",
  signals: Signal[],
  rows: Feature[],
  takeProfit: number,
  stopLoss: number,
  horizonBars: number,
  outcomeCache: OutcomeCache,
): Stats {
  const stats: Stats = {
    pattern,
    direction,
    takeProfit,
    stopLoss,
    horizonBars,
    total: 0,
    wins: 0,
    sum: 0,
    positive: 0,
    negative: 0,
    trainTotal: 0,
    trainWins: 0,
    trainSum: 0,
    trainPositive: 0,
    trainNegative: 0,
    testTotal: 0,
    testWins: 0,
    testSum: 0,
    testPositive: 0,
    testNegative: 0,
    maxDrawdown: 0,
  };
  let lastAccepted = -Infinity;
  let equity = 0;
  let peak = 0;
  for (const signal of signals) {
    if (signal.index - lastAccepted < COOLDOWN_BARS) continue;
    const cacheKey = `${signal.ticker}|${signal.index}|${signal.direction}|${takeProfit}|${stopLoss}|${horizonBars}`;
    let value = outcomeCache.get(cacheKey);
    if (value === undefined) {
      value = evaluate(rows, signal, takeProfit, stopLoss, horizonBars);
      outcomeCache.set(cacheKey, value);
    }
    if (value === null) continue;
    lastAccepted = signal.index;
    updateStats(stats, value, rows[signal.index].train);
    equity += value;
    peak = Math.max(peak, equity);
    stats.maxDrawdown = Math.max(stats.maxDrawdown, peak - equity);
  }
  return stats;
}

function metric(stats: Stats) {
  const wilson = (successes: number, total: number) => {
    if (total === 0) return { low: 0, high: 0 };
    const z = 1.96;
    const rate = successes / total;
    const denominator = 1 + (z * z) / total;
    const center = (rate + (z * z) / (2 * total)) / denominator;
    const spread =
      (z *
        Math.sqrt(
          (rate * (1 - rate) + (z * z) / (4 * total)) / total,
        )) /
      denominator;
    return {
      low: Math.max(0, center - spread),
      high: Math.min(1, center + spread),
    };
  };
  const trainWinInterval = wilson(stats.trainWins, stats.trainTotal);
  const testWinInterval = wilson(stats.testWins, stats.testTotal);
  return {
    pattern: stats.pattern,
    direction: stats.direction,
    takeProfit: stats.takeProfit,
    stopLoss: stats.stopLoss,
    horizonHours: stats.horizonBars,
    total: stats.total,
    winRate: stats.total ? stats.wins / stats.total : 0,
    expectancy: stats.total ? stats.sum / stats.total : 0,
    profitFactor:
      stats.negative < 0 ? stats.positive / Math.abs(stats.negative) : null,
    trainTotal: stats.trainTotal,
    trainWinRate: stats.trainTotal ? stats.trainWins / stats.trainTotal : 0,
    trainWinRate95Low: trainWinInterval.low,
    trainWinRate95High: trainWinInterval.high,
    trainExpectancy: stats.trainTotal
      ? stats.trainSum / stats.trainTotal
      : 0,
    trainProfitFactor:
      stats.trainNegative < 0
        ? stats.trainPositive / Math.abs(stats.trainNegative)
        : null,
    testTotal: stats.testTotal,
    testWinRate: stats.testTotal ? stats.testWins / stats.testTotal : 0,
    testWinRate95Low: testWinInterval.low,
    testWinRate95High: testWinInterval.high,
    testExpectancy: stats.testTotal ? stats.testSum / stats.testTotal : 0,
    testProfitFactor:
      stats.testNegative < 0
        ? stats.testPositive / Math.abs(stats.testNegative)
        : null,
    maxSingleTickerDrawdown: stats.maxDrawdown,
  };
}

function emptyStats(
  pattern: string,
  direction: "BUY" | "SELL",
  takeProfit: number,
  stopLoss: number,
  horizonBars: number,
): Stats {
  return {
    pattern,
    direction,
    takeProfit,
    stopLoss,
    horizonBars,
    total: 0,
    wins: 0,
    sum: 0,
    positive: 0,
    negative: 0,
    trainTotal: 0,
    trainWins: 0,
    trainSum: 0,
    trainPositive: 0,
    trainNegative: 0,
    testTotal: 0,
    testWins: 0,
    testSum: 0,
    testPositive: 0,
    testNegative: 0,
    maxDrawdown: 0,
  };
}

async function main() {
  const [groups, marketRegimes] = await Promise.all([
    loadCandles(),
    loadMarketRegimes(),
  ]);
  const aggregated = new Map<string, Signal[]>();
  const featureRows = new Map<string, Feature[]>();
  const signalsByKeyAndTicker = new Map<string, Map<string, Signal[]>>();
  let candleCount = 0;
  for (const [ticker, candles] of groups) {
    candleCount += candles.length;
    if (candles.length < 100) continue;
    const rows = buildFeatures(candles, marketRegimes);
    featureRows.set(ticker, rows);
    const signals = detectSignals(rows);
    for (const signal of signals) {
      const key = `${signal.pattern}|${signal.direction}`;
      const list = aggregated.get(key) ?? [];
      list.push(signal);
      aggregated.set(key, list);
      const tickerMap = signalsByKeyAndTicker.get(key) ?? new Map<string, Signal[]>();
      const own = tickerMap.get(ticker) ?? [];
      own.push(signal);
      tickerMap.set(ticker, own);
      signalsByKeyAndTicker.set(key, tickerMap);
    }
  }

  const results: ReturnType<typeof metric>[] = [];
  const outcomeCache: OutcomeCache = new Map();
  for (const [key, signals] of aggregated) {
    const [pattern, direction] = key.split("|") as [
      string,
      "BUY" | "SELL",
    ];
    const byTicker = signalsByKeyAndTicker.get(key) ?? new Map<string, Signal[]>();
    for (const takeProfit of TAKE_PROFITS) {
      for (const stopLoss of STOP_LOSSES) {
        for (const horizonBars of HORIZONS) {
          const stats: Stats = {
            pattern,
            direction,
            takeProfit,
            stopLoss,
            horizonBars,
            total: 0,
            wins: 0,
            sum: 0,
            positive: 0,
            negative: 0,
            trainTotal: 0,
            trainWins: 0,
            trainSum: 0,
            trainPositive: 0,
            trainNegative: 0,
            testTotal: 0,
            testWins: 0,
            testSum: 0,
            testPositive: 0,
            testNegative: 0,
            maxDrawdown: 0,
          };
          for (const [ticker, tickerSignals] of byTicker) {
            const own = statsFor(
              pattern,
              direction,
              tickerSignals,
              featureRows.get(ticker) ?? [],
              takeProfit,
              stopLoss,
              horizonBars,
              outcomeCache,
            );
            mergeStats(stats, own);
          }
          const result = metric(stats);
          if (
            result.total >= MIN_TOTAL &&
            result.trainTotal >= MIN_TRAIN &&
            result.testTotal >= MIN_TEST
          ) {
            results.push(result);
          }
        }
      }
    }
  }
  results.sort(
    (left, right) =>
      right.testExpectancy - left.testExpectancy ||
      (right.testProfitFactor ?? 0) - (left.testProfitFactor ?? 0),
  );
  const positive = results
    .filter((item) => item.trainExpectancy > 0 && item.testExpectancy > 0)
    .slice(0, 6);
  const segmentRanges = [
    ["2024-H2", new Date("2024-08-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z")],
    ["2025-H1", new Date("2025-01-01T00:00:00.000Z"), new Date("2025-07-01T00:00:00.000Z")],
    ["2025-H2", new Date("2025-07-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")],
    ["2026-Q1", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z")],
    ["2026-Q2", new Date("2026-04-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z")],
    ["2026-Q3", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-10-01T00:00:00.000Z")],
  ] as const;
  const stability = positive.map((candidate) => {
    const key = `${candidate.pattern}|${candidate.direction}`;
    const tickerSignals = signalsByKeyAndTicker.get(key) ?? new Map<string, Signal[]>();
    const segments = segmentRanges.map(([name, start, end]) => {
      const segmentStats = emptyStats(
        candidate.pattern,
        candidate.direction,
        candidate.takeProfit,
        candidate.stopLoss,
        candidate.horizonHours,
      );
      for (const [ticker, signals] of tickerSignals) {
        const filtered = signals.filter(
          (signal) => signal.timestamp >= start && signal.timestamp < end,
        );
        if (!filtered.length) continue;
        const own = statsFor(
          candidate.pattern,
          candidate.direction,
          filtered,
          featureRows.get(ticker) ?? [],
          candidate.takeProfit,
          candidate.stopLoss,
          candidate.horizonHours,
          outcomeCache,
        );
        mergeStats(segmentStats, own);
      }
      const summary = metric(segmentStats);
      return {
        segment: name,
        total: summary.total,
        winRate: summary.winRate,
        expectancy: summary.expectancy,
        profitFactor: summary.profitFactor,
      };
    });
    const tickerSupport = [...tickerSignals.entries()]
      .map(([ticker, signals]) => {
        const own = statsFor(
          candidate.pattern,
          candidate.direction,
          signals,
          featureRows.get(ticker) ?? [],
          candidate.takeProfit,
          candidate.stopLoss,
          candidate.horizonHours,
          outcomeCache,
        );
        const summary = metric(own);
        return {
          ticker,
          total: summary.total,
          testTotal: summary.testTotal,
          testWinRate: summary.testWinRate,
          testExpectancy: summary.testExpectancy,
        };
      })
      .filter((item) => item.testTotal >= 10)
      .sort((left, right) => right.testExpectancy - left.testExpectancy);
    return {
      candidate,
      positiveSegments: segments.filter(
        (item) => item.total >= 20 && item.expectancy > 0,
      ).length,
      segments,
      tickerSupport,
    };
  });
  console.log(
    JSON.stringify(
      {
        timeframe: TIMEFRAME,
        candleCount,
        tickers: groups.size,
        trainCutoff: TRAIN_CUTOFF.toISOString(),
        costsPercent: COST_PERCENT,
        cooldownBars: COOLDOWN_BARS,
        positiveTrainAndTest: positive.length,
        stability,
        top: results.slice(0, 100),
      },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});