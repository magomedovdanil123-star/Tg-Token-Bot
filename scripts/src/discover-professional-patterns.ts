import { and, asc, eq, sql } from "drizzle-orm";
import {
  candles,
  db,
  detectedPatterns,
  moexTickers,
  patternStatistics,
  pool,
} from "@workspace/db";

const TIMEFRAME = "10m";
const HORIZONS = [30, 60, 120, 240, 720];
const TAKE_PROFITS = [0.25, 0.5, 1, 1.5];
const STOP_LOSSES = [0.25, 0.5, 1, 1.5];
const MAX_EXIT_SAMPLES = 3000;

type Candle = {
  ticker: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Detection = {
  start: number;
  end: number;
  type: string;
  direction: "BUY" | "SELL";
  confidence: number;
  parameters: Record<string, unknown>;
};

type ExitStat = {
  count: number;
  trainCount: number;
  trainWins: number;
  trainSum: number;
};

type Bucket = {
  ticker: string;
  type: string;
  direction: "BUY" | "SELL";
  occurrences: number;
  wins: Record<number, number>;
  sums: Record<number, number>;
  positive: Record<number, number>;
  negative: Record<number, number>;
  trainCount: Record<number, number>;
  trainWins: Record<number, number>;
  trainSum: Record<number, number>;
  testCount: Record<number, number>;
  testWins: Record<number, number>;
  testSum: Record<number, number>;
  drawdown: Record<number, number>;
  equity: Record<number, number>;
  peak: Record<number, number>;
  exits: Record<string, ExitStat>;
  exitSamples: number;
  start: number;
  end: number;
};

function positive(value: number) {
  return value > 0;
}

function body(candle: Candle) {
  return Math.abs(candle.close - candle.open);
}

function range(candle: Candle) {
  return Math.max(candle.high - candle.low, 0);
}

function upperShadow(candle: Candle) {
  return candle.high - Math.max(candle.open, candle.close);
}

function lowerShadow(candle: Candle) {
  return Math.min(candle.open, candle.close) - candle.low;
}

function bullish(candle: Candle) {
  return candle.close > candle.open;
}

function bearish(candle: Candle) {
  return candle.close < candle.open;
}

function doji(candle: Candle) {
  const candleRange = range(candle);
  return candleRange > 0 && body(candle) / candleRange <= 0.1;
}

function near(left: number, right: number, tolerance: number) {
  return Math.abs(left - right) <= Math.max(Math.abs(right) * tolerance, 0.0000001);
}

function localHigh(rows: Candle[], index: number, lookback = 5) {
  if (index < lookback) return false;
  const value = rows[index].high;
  return rows.slice(index - lookback, index).every((row) => row.high <= value) &&
    rows.slice(index + 1, index + lookback + 1).every((row) => row.high <= value);
}

function localLow(rows: Candle[], index: number, lookback = 5) {
  if (index < lookback) return false;
  const value = rows[index].low;
  return rows.slice(index - lookback, index).every((row) => row.low >= value) &&
    rows.slice(index + 1, index + lookback + 1).every((row) => row.low >= value);
}

function trend(rows: Candle[], index: number, bars: number) {
  if (index < bars) return 0;
  const first = rows[index - bars].close;
  const last = rows[index].close;
  return last > first * 1.005 ? 1 : last < first * 0.995 ? -1 : 0;
}

function add(
  result: Detection[],
  rows: Candle[],
  start: number,
  end: number,
  type: string,
  direction: "BUY" | "SELL",
  confidence: number,
  parameters: Record<string, unknown> = {},
) {
  if (start < 0 || end >= rows.length) return;
  result.push({
    start,
    end,
    type,
    direction,
    confidence: Math.max(0, Math.min(1, confidence)),
    parameters,
  });
}

function detectCandles(rows: Candle[], index: number, result: Detection[]) {
  const current = rows[index];
  const previous = rows[index - 1];
  if (!previous) return;
  const r = range(current);
  const b = body(current);
  const lower = lowerShadow(current);
  const upper = upperShadow(current);
  const currentBull = bullish(current);
  const currentBear = bearish(current);
  const priorTrend = trend(rows, index, 3);

  if (r > 0 && lower >= b * 2 && upper <= Math.max(b * 0.5, r * 0.05) && b / r <= 0.45) {
    add(result, rows, index, index, "Hammer", "BUY", 0.84, { bodyToRange: b / r });
    if (priorTrend > 0) add(result, rows, index, index, "Hanging Man", "SELL", 0.8, { priorTrend });
  }
  if (r > 0 && upper >= b * 2 && lower <= Math.max(b * 0.5, r * 0.05) && b / r <= 0.45) {
    add(result, rows, index, index, "Inverted Hammer", "BUY", 0.8, { bodyToRange: b / r });
    if (priorTrend > 0) add(result, rows, index, index, "Shooting Star", "SELL", 0.84, { priorTrend });
  }
  if (doji(current)) {
    add(result, rows, index, index, "Doji", "BUY", 0.65, { bodyToRange: r ? b / r : 0 });
    if (r > 0 && upper <= r * 0.1 && lower >= r * 0.6) {
      add(result, rows, index, index, "Dragonfly Doji", "BUY", 0.82, { upperRatio: upper / r });
    }
    if (r > 0 && lower <= r * 0.1 && upper >= r * 0.6) {
      add(result, rows, index, index, "Gravestone Doji", "SELL", 0.82, { lowerRatio: lower / r });
    }
    if (r > 0 && upper >= r * 0.3 && lower >= r * 0.3) {
      add(result, rows, index, index, "Long Legged Doji", "BUY", 0.7, { upperRatio: upper / r, lowerRatio: lower / r });
    }
  }

  if (currentBull && bearish(previous) && current.open <= previous.close && current.close >= previous.open) {
    add(result, rows, index - 1, index, "Engulfing Bullish", "BUY", 0.9, { engulfedRange: range(previous) });
  }
  if (currentBear && bullish(previous) && current.open >= previous.close && current.close <= previous.open) {
    add(result, rows, index - 1, index, "Engulfing Bearish", "SELL", 0.9, { engulfedRange: range(previous) });
  }
  const currentBodyHigh = Math.max(current.open, current.close);
  const currentBodyLow = Math.min(current.open, current.close);
  const previousBodyHigh = Math.max(previous.open, previous.close);
  const previousBodyLow = Math.min(previous.open, previous.close);
  if (currentBodyHigh <= previousBodyHigh && currentBodyLow >= previousBodyLow) {
    if (currentBull && bearish(previous)) add(result, rows, index - 1, index, "Harami", "BUY", 0.74);
    if (currentBear && bullish(previous)) add(result, rows, index - 1, index, "Harami", "SELL", 0.74);
  }
  if (bearish(previous) && currentBull && current.close > (previous.open + previous.close) / 2 && current.close < previous.open) {
    add(result, rows, index - 1, index, "Piercing Line", "BUY", 0.8);
  }
  if (bullish(previous) && currentBear && current.close < (previous.open + previous.close) / 2 && current.close > previous.open) {
    add(result, rows, index - 1, index, "Dark Cloud Cover", "SELL", 0.8);
  }
  if (index >= 2) {
    const first = rows[index - 2];
    const middle = rows[index - 1];
    if (bearish(first) && body(middle) <= range(middle) * 0.4 && currentBull && current.close > (first.open + first.close) / 2) {
      add(result, rows, index - 2, index, "Morning Star", "BUY", 0.86);
    }
    if (bullish(first) && body(middle) <= range(middle) * 0.4 && currentBear && current.close < (first.open + first.close) / 2) {
      add(result, rows, index - 2, index, "Evening Star", "SELL", 0.86);
    }
    const three = rows.slice(index - 2, index + 1);
    if (three.every(bullish) && three[1].close > three[0].close && three[2].close > three[1].close) {
      add(result, rows, index - 2, index, "Three White Soldiers", "BUY", 0.87);
    }
    if (three.every(bearish) && three[1].close < three[0].close && three[2].close < three[1].close) {
      add(result, rows, index - 2, index, "Three Black Crows", "SELL", 0.87);
    }
    if (near(first.high, current.high, 0.001) && bullish(first) !== bullish(current)) {
      add(result, rows, index - 2, index, "Tweezer Top", "SELL", 0.76, { high: current.high });
    }
    if (near(first.low, current.low, 0.001) && bullish(first) !== bullish(current)) {
      add(result, rows, index - 2, index, "Tweezer Bottom", "BUY", 0.76, { low: current.low });
    }
  }
  if (r > 0 && b / r >= 0.9) {
    add(result, rows, index, index, "Marubozu", currentBull ? "BUY" : "SELL", 0.78, { bodyToRange: b / r });
  }
  if (r > 0 && b / r <= 0.3 && upper / r >= 0.2 && lower / r >= 0.2) {
    add(result, rows, index, index, "Spinning Top", priorTrend >= 0 ? "SELL" : "BUY", 0.66);
  }
  if (r > 0 && ((currentBull && current.open <= current.low + r * 0.1) || (currentBear && current.open >= current.high - r * 0.1))) {
    add(result, rows, index, index, "Belt Hold", currentBull ? "BUY" : "SELL", 0.7);
  }
  if (b / Math.max(range(previous), 0.0000001) >= 0.8 && currentBull !== bullish(previous) && Math.abs(current.open - previous.close) >= range(previous) * 0.05) {
    add(result, rows, index - 1, index, "Kicking", currentBull ? "BUY" : "SELL", 0.78);
  }
  if (index >= 4) {
    const first = rows[index - 4];
    const middle = rows.slice(index - 3, index);
    if (bullish(first) && middle.every((row) => row.high < first.high && row.low > first.low) && currentBull && current.close > first.high) {
      add(result, rows, index - 4, index, "Rising Three Methods", "BUY", 0.8);
    }
    if (bearish(first) && middle.every((row) => row.high < first.high && row.low > first.low) && currentBear && current.close < first.low) {
      add(result, rows, index - 4, index, "Falling Three Methods", "SELL", 0.8);
    }
  }
}

function detectStructures(rows: Candle[], index: number, result: Detection[]) {
  if (index < 12) return;
  const current = rows[index];
  const window = rows.slice(index - 19, index + 1);
  const highs = window.map((row) => row.high);
  const lows = window.map((row) => row.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const midpoint = (high + low) / 2;
  const tolerance = Math.max((high - low) * 0.04, current.close * 0.002);
  const peaks = window
    .map((row, offset) => ({ value: row.high, index: index - 19 + offset }))
    .filter((point) => localHigh(rows, point.index, 2));
  const troughs = window
    .map((row, offset) => ({ value: row.low, index: index - 19 + offset }))
    .filter((point) => localLow(rows, point.index, 2));
  if (peaks.length >= 2) {
    const pair = peaks.slice(-2);
    if (Math.abs(pair[0].value - pair[1].value) <= tolerance) {
      add(result, rows, pair[0].index, index, "Double Top", "SELL", 0.79, { resistance: pair[1].value, tolerance });
    }
  }
  if (troughs.length >= 2) {
    const pair = troughs.slice(-2);
    if (Math.abs(pair[0].value - pair[1].value) <= tolerance) {
      add(result, rows, pair[0].index, index, "Double Bottom", "BUY", 0.79, { support: pair[1].value, tolerance });
    }
  }
  if (peaks.length >= 3 && peaks.slice(-3).every((point) => Math.abs(point.value - peaks[peaks.length - 1].value) <= tolerance)) {
    add(result, rows, peaks[peaks.length - 3].index, index, "Triple Top", "SELL", 0.82, { resistance: high });
  }
  if (troughs.length >= 3 && troughs.slice(-3).every((point) => Math.abs(point.value - troughs[troughs.length - 1].value) <= tolerance)) {
    add(result, rows, troughs[troughs.length - 3].index, index, "Triple Bottom", "BUY", 0.82, { support: low });
  }

  const firstHigh = Math.max(...window.slice(0, 6).map((row) => row.high));
  const lastHigh = Math.max(...window.slice(-6).map((row) => row.high));
  const firstLow = Math.min(...window.slice(0, 6).map((row) => row.low));
  const lastLow = Math.min(...window.slice(-6).map((row) => row.low));
  const highsSlope = lastHigh - firstHigh;
  const lowsSlope = lastLow - firstLow;
  if (Math.abs(highsSlope) <= tolerance * 0.6 && lowsSlope > tolerance * 0.5) {
    add(result, rows, index - 19, index, "Ascending Triangle", "BUY", 0.77, { upperSlope: highsSlope, lowerSlope: lowsSlope });
  }
  if (Math.abs(lowsSlope) <= tolerance * 0.6 && highsSlope < -tolerance * 0.5) {
    add(result, rows, index - 19, index, "Descending Triangle", "SELL", 0.77, { upperSlope: highsSlope, lowerSlope: lowsSlope });
  }
  if (highsSlope < -tolerance * 0.5 && lowsSlope > tolerance * 0.5) {
    add(result, rows, index - 19, index, "Symmetrical Triangle", current.close >= midpoint ? "BUY" : "SELL", 0.73, { upperSlope: highsSlope, lowerSlope: lowsSlope });
  }
  if (highsSlope > tolerance * 0.5 && lowsSlope > tolerance * 0.5 && highsSlope > lowsSlope) {
    add(result, rows, index - 19, index, "Rising Wedge", "SELL", 0.74, { upperSlope: highsSlope, lowerSlope: lowsSlope });
  }
  if (highsSlope < -tolerance * 0.5 && lowsSlope < -tolerance * 0.5 && Math.abs(lowsSlope) > Math.abs(highsSlope)) {
    add(result, rows, index - 19, index, "Falling Wedge", "BUY", 0.74, { upperSlope: highsSlope, lowerSlope: lowsSlope });
  }
  const impulse = rows[index - 12];
  const impulseReturn = impulse ? (current.close - impulse.close) / impulse.close : 0;
  const consolidationRange = Math.max(...window.slice(-6).map((row) => row.high)) - Math.min(...window.slice(-6).map((row) => row.low));
  if (Math.abs(impulseReturn) > 0.035 && consolidationRange < Math.abs(current.close - impulse.close) * 0.55) {
    add(result, rows, index - 12, index, "Flag", impulseReturn > 0 ? "BUY" : "SELL", 0.72, { impulseReturn, consolidationRange });
    add(result, rows, index - 12, index, "Pennant", impulseReturn > 0 ? "BUY" : "SELL", 0.7, { impulseReturn, consolidationRange });
  }
  if (Math.abs(highsSlope) <= tolerance * 0.5 && Math.abs(lowsSlope) <= tolerance * 0.5) {
    add(result, rows, index - 19, index, "Rectangle", current.close >= midpoint ? "BUY" : "SELL", 0.68, { high, low });
  }
  if (Math.abs(highsSlope - lowsSlope) <= tolerance * 0.7 && Math.abs(highsSlope) > tolerance * 0.2) {
    add(result, rows, index - 19, index, "Channel", current.close >= midpoint ? "BUY" : "SELL", 0.67, { highSlope: highsSlope, lowSlope: lowsSlope });
  }
  if (index >= 30) {
    const cup = rows.slice(index - 30, index - 5);
    const left = cup.slice(0, 6).reduce((sum, row) => sum + row.close, 0) / 6;
    const center = Math.min(...cup.map((row) => row.close));
    const right = cup.slice(-6).reduce((sum, row) => sum + row.close, 0) / 6;
    const handle = rows.slice(index - 4, index + 1);
    if (left > center * 1.03 && right > center * 1.03 && Math.abs(left - right) / left < 0.06 && Math.max(...handle.map((row) => row.close)) < right * 1.01) {
      add(result, rows, index - 30, index, "Cup and Handle", "BUY", 0.75, { left, center, right });
    }
  }
  if (peaks.length >= 3 && troughs.length >= 2) {
    const lastPeaks = peaks.slice(-3);
    const lastTroughs = troughs.slice(-2);
    if (lastPeaks[1].value > lastPeaks[0].value && lastPeaks[1].value > lastPeaks[2].value &&
        Math.abs(lastPeaks[0].value - lastPeaks[2].value) <= tolerance &&
        lastTroughs[0].value < lastTroughs[1].value) {
      add(result, rows, lastPeaks[0].index, index, "Head and Shoulders", "SELL", 0.83, { neckline: Math.min(lastTroughs[0].value, lastTroughs[1].value) });
    }
    if (lastPeaks[1].value < lastPeaks[0].value && lastPeaks[1].value < lastPeaks[2].value &&
        Math.abs(lastPeaks[0].value - lastPeaks[2].value) <= tolerance &&
        lastTroughs[0].value > lastTroughs[1].value) {
      add(result, rows, lastPeaks[0].index, index, "Inverse Head and Shoulders", "BUY", 0.83, { neckline: Math.max(lastTroughs[0].value, lastTroughs[1].value) });
    }
  }
}

function detectSmartMoney(rows: Candle[], index: number, result: Detection[]) {
  if (index < 10) return;
  const current = rows[index];
  const recent = rows.slice(index - 10, index);
  const priorHigh = Math.max(...recent.map((row) => row.high));
  const priorLow = Math.min(...recent.map((row) => row.low));
  const previousTrend = trend(rows, index - 1, 8);
  if (current.close > priorHigh) add(result, rows, index - 10, index, "BOS", "BUY", 0.8, { brokenLevel: priorHigh });
  if (current.close < priorLow) add(result, rows, index - 10, index, "BOS", "SELL", 0.8, { brokenLevel: priorLow });
  if (previousTrend < 0 && current.close > priorHigh) add(result, rows, index - 10, index, "CHOCH", "BUY", 0.82, { previousTrend, brokenLevel: priorHigh });
  if (previousTrend > 0 && current.close < priorLow) add(result, rows, index - 10, index, "CHOCH", "SELL", 0.82, { previousTrend, brokenLevel: priorLow });
  if (current.high > priorHigh && current.close < priorHigh) {
    add(result, rows, index - 10, index, "Liquidity Sweep", "SELL", 0.8, { sweptLevel: priorHigh });
  }
  if (current.low < priorLow && current.close > priorLow) {
    add(result, rows, index - 10, index, "Liquidity Sweep", "BUY", 0.8, { sweptLevel: priorLow });
  }
  if (recent.some((row) => near(row.high, current.high, 0.001))) {
    add(result, rows, index - 10, index, "Equal Highs", "SELL", 0.68, { level: current.high });
  }
  if (recent.some((row) => near(row.low, current.low, 0.001))) {
    add(result, rows, index - 10, index, "Equal Lows", "BUY", 0.68, { level: current.low });
  }
  const twoBack = rows[index - 2];
  if (twoBack && current.low > twoBack.high) {
    add(result, rows, index - 2, index, "Fair Value Gap", "BUY", 0.82, { gapLow: twoBack.high, gapHigh: current.low });
    add(result, rows, index - 2, index, "Imbalance", "BUY", 0.75, { gap: current.low - twoBack.high });
  }
  if (twoBack && current.high < twoBack.low) {
    add(result, rows, index - 2, index, "Fair Value Gap", "SELL", 0.82, { gapLow: current.high, gapHigh: twoBack.low });
    add(result, rows, index - 2, index, "Imbalance", "SELL", 0.75, { gap: twoBack.low - current.high });
  }
  const opposite = rows[index - 1];
  if (opposite && bullish(current) && bearish(opposite) && current.close > priorHigh) {
    add(result, rows, index - 1, index, "Order Block", "BUY", 0.79, { zoneLow: opposite.low, zoneHigh: opposite.high });
  }
  if (opposite && bearish(current) && bullish(opposite) && current.close < priorLow) {
    add(result, rows, index - 1, index, "Order Block", "SELL", 0.79, { zoneLow: opposite.low, zoneHigh: opposite.high });
  }
  if (opposite && current.low <= opposite.high && current.high >= opposite.low && previousTrend < 0) {
    add(result, rows, index - 1, index, "Breaker Block", "BUY", 0.69, { zoneLow: opposite.low, zoneHigh: opposite.high });
  }
  if (opposite && current.low <= opposite.high && current.high >= opposite.low && previousTrend > 0) {
    add(result, rows, index - 1, index, "Breaker Block", "SELL", 0.69, { zoneLow: opposite.low, zoneHigh: opposite.high });
  }
  if (opposite && current.low <= opposite.high && current.high >= opposite.low) {
    add(result, rows, index - 1, index, "Mitigation Block", bullish(opposite) ? "BUY" : "SELL", 0.66, { zoneLow: opposite.low, zoneHigh: opposite.high });
  }
  const rangeHigh = Math.max(...rows.slice(index - 20, index + 1).map((row) => row.high));
  const rangeLow = Math.min(...rows.slice(index - 20, index + 1).map((row) => row.low));
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize > 0 && current.close > (rangeHigh + rangeLow) / 2) {
    add(result, rows, index - 20, index, "Premium/Discount Zone", "SELL", 0.64, { zone: "premium", rangeHigh, rangeLow });
  } else if (rangeSize > 0) {
    add(result, rows, index - 20, index, "Premium/Discount Zone", "BUY", 0.64, { zone: "discount", rangeHigh, rangeLow });
  }
}

function detect(rows: Candle[]) {
  const result: Detection[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    detectCandles(rows, index, result);
    // Structural models describe zones, not individual ticks. Sampling them
    // prevents the same still-valid zone from being emitted on every bar.
    if (index % 10 === 0) detectStructures(rows, index, result);
    if (index % 5 === 0) detectSmartMoney(rows, index, result);
  }
  const cooldowns: Record<string, number> = {
    "Hammer": 1, "Inverted Hammer": 1, "Hanging Man": 1, "Shooting Star": 1,
    "Doji": 1, "Dragonfly Doji": 1, "Gravestone Doji": 1, "Long Legged Doji": 1,
    "Engulfing Bullish": 1, "Engulfing Bearish": 1, "Harami": 1,
    "Piercing Line": 1, "Dark Cloud Cover": 1, "Morning Star": 1, "Evening Star": 1,
    "Three White Soldiers": 1, "Three Black Crows": 1, "Tweezer Top": 1, "Tweezer Bottom": 1,
    "Marubozu": 1, "Spinning Top": 1, "Belt Hold": 1, "Kicking": 1,
    "Rising Three Methods": 1, "Falling Three Methods": 1,
    "Double Top": 120, "Double Bottom": 120, "Triple Top": 240, "Triple Bottom": 240,
    "Ascending Triangle": 120, "Descending Triangle": 120, "Symmetrical Triangle": 120,
    "Rising Wedge": 120, "Falling Wedge": 120, "Flag": 80, "Pennant": 80,
    "Rectangle": 120, "Channel": 120, "Cup and Handle": 240,
    "Head and Shoulders": 240, "Inverse Head and Shoulders": 240,
    "BOS": 30, "CHOCH": 30, "Liquidity Sweep": 30, "Equal Highs": 80, "Equal Lows": 80,
    "Order Block": 60, "Breaker Block": 60, "Mitigation Block": 60,
    "Fair Value Gap": 30, "Imbalance": 30, "Premium/Discount Zone": 120,
  };
  const accepted: Detection[] = [];
  const lastByPattern = new Map<string, number>();
  for (const event of result.sort((left, right) => left.end - right.end)) {
    const key = `${event.type}:${event.direction}`;
    const previousEnd = lastByPattern.get(key);
    if (previousEnd !== undefined && event.end - previousEnd < (cooldowns[event.type] ?? 5)) {
      continue;
    }
    accepted.push(event);
    lastByPattern.set(key, event.end);
  }
  return accepted;
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-absolute * absolute);
  return 0.5 * (1 + sign * polynomial);
}

function pValue(wins: number, total: number) {
  if (total < 2) return 1;
  const z = Math.abs(wins / total - 0.5) / Math.sqrt(0.25 / total);
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}

function interval(wins: number, total: number) {
  if (!total) return [0, 0] as const;
  const rate = wins / total;
  const z = 1.96;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, center - spread), Math.min(1, center + spread)] as const;
}

function bucketKey(ticker: string, type: string, direction: string) {
  return `${ticker}|${type}|${direction}`;
}

function integerArg(name: string, fallback: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  const parsed = raw === undefined ? fallback : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function makeBucket(ticker: string, type: string, direction: "BUY" | "SELL", start: number, end: number): Bucket {
  const exits: Record<string, ExitStat> = {};
  for (const tp of TAKE_PROFITS) for (const sl of STOP_LOSSES) exits[`${tp}:${sl}`] = { count: 0, trainCount: 0, trainWins: 0, trainSum: 0 };
  return {
    ticker, type, direction, occurrences: 0,
    wins: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    sums: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    positive: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    negative: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    trainCount: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    trainWins: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    trainSum: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    testCount: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    testWins: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    testSum: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    drawdown: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    equity: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    peak: Object.fromEntries(HORIZONS.map((h) => [h, 0])),
    exits, exitSamples: 0, start, end,
  };
}

function closeReturn(rows: Candle[], index: number, bars: number, direction: "BUY" | "SELL") {
  const future = rows[index + bars];
  const entry = rows[index]?.close;
  if (!future || !entry) return undefined;
  return direction === "BUY" ? ((future.close - entry) / entry) * 100 : ((entry - future.close) / entry) * 100;
}

function exitReturn(rows: Candle[], index: number, bars: number, direction: "BUY" | "SELL", tp: number, sl: number) {
  const entry = rows[index]?.close;
  if (!entry) return undefined;
  const target = direction === "BUY" ? entry * (1 + tp / 100) : entry * (1 - tp / 100);
  const stop = direction === "BUY" ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
  const last = Math.min(rows.length - 1, index + bars);
  for (let cursor = index + 1; cursor <= last; cursor += 1) {
    const row = rows[cursor];
    const stopHit = direction === "BUY" ? row.low <= stop : row.high >= stop;
    const targetHit = direction === "BUY" ? row.high >= target : row.low <= target;
    if (stopHit) return -sl;
    if (targetHit) return tp;
  }
  return closeReturn(rows, index, bars, direction);
}

function updateBucket(bucket: Bucket, rows: Candle[], event: Detection, split: number) {
  bucket.occurrences += 1;
  bucket.start = Math.min(bucket.start, event.start);
  bucket.end = Math.max(bucket.end, event.end);
  const inTrain = event.end < split;
  for (const horizon of HORIZONS) {
    const value = closeReturn(rows, event.end, Math.round(horizon / 10), event.direction);
    if (value === undefined) continue;
    bucket.sums[horizon] += value;
    bucket.wins[horizon] += positive(value) ? 1 : 0;
    if (value > 0) bucket.positive[horizon] += value;
    else bucket.negative[horizon] += value;
    bucket.equity[horizon] += value;
    bucket.peak[horizon] = Math.max(bucket.peak[horizon], bucket.equity[horizon]);
    bucket.drawdown[horizon] = Math.max(bucket.drawdown[horizon], bucket.peak[horizon] - bucket.equity[horizon]);
    if (inTrain) {
      bucket.trainCount[horizon] += 1;
      bucket.trainWins[horizon] += positive(value) ? 1 : 0;
      bucket.trainSum[horizon] += value;
    } else {
      bucket.testCount[horizon] += 1;
      bucket.testWins[horizon] += positive(value) ? 1 : 0;
      bucket.testSum[horizon] += value;
    }
    if (bucket.exitSamples < MAX_EXIT_SAMPLES) {
      for (const tp of TAKE_PROFITS) for (const sl of STOP_LOSSES) {
        const exit = exitReturn(rows, event.end, Math.round(horizon / 10), event.direction, tp, sl);
        const stats = bucket.exits[`${tp}:${sl}`];
        if (exit === undefined || !stats) continue;
        stats.count += 1;
        if (inTrain) {
          stats.trainCount += 1;
          stats.trainWins += positive(exit) ? 1 : 0;
          stats.trainSum += exit;
        }
      }
    }
  }
  bucket.exitSamples += 1;
}

function chooseHorizon(bucket: Bucket) {
  return HORIZONS.filter((h) => bucket.trainCount[h] >= 20)
    .sort((a, b) => bucket.trainSum[b] / bucket.trainCount[b] - bucket.trainSum[a] / bucket.trainCount[a])[0] ?? 60;
}

function buildStats(bucket: Bucket, qValue: number, horizon: number) {
  const count = bucket.trainCount[horizon] + bucket.testCount[horizon];
  const wins = bucket.wins[horizon];
  const [confidenceLow, confidenceHigh] = interval(wins, count);
  const bestExit = Object.entries(bucket.exits)
    .filter(([, value]) => value.trainCount >= 20)
    .sort(([, left], [, right]) => right.trainSum / right.trainCount - left.trainSum / left.trainCount)[0];
  const [bestTakeProfit, bestStopLoss] = (bestExit?.[0] ?? "0.5:0.5").split(":").map(Number);
  const trainCount = bucket.trainCount[horizon];
  const testCount = bucket.testCount[horizon];
  const significant = count >= 30 && trainCount >= 15 && testCount >= 15 &&
    bucket.trainSum[horizon] / Math.max(trainCount, 1) > 0 &&
    bucket.testSum[horizon] / Math.max(testCount, 1) > 0 &&
    pValue(wins, count) <= 0.05 && qValue <= 0.1;
  return {
    ticker: bucket.ticker, timeframe: TIMEFRAME, patternType: bucket.type, direction: bucket.direction,
    occurrences: count,
    winRate: count ? wins / count : 0,
    profitFactor: bucket.negative[horizon] === 0 ? null : bucket.positive[horizon] / Math.abs(bucket.negative[horizon]),
    expectancy: count ? bucket.sums[horizon] / count : 0,
    averageProfit: wins ? bucket.positive[horizon] / wins : 0,
    averageLoss: count - wins ? bucket.negative[horizon] / (count - wins) : 0,
    maxDrawdown: bucket.drawdown[horizon],
    bestTakeProfit, bestStopLoss, bestHoldingMinutes: horizon,
    pValue: pValue(wins, count), qValue,
    confidenceLow, confidenceHigh,
    trainWinRate: trainCount ? bucket.trainWins[horizon] / trainCount : 0,
    testWinRate: testCount ? bucket.testWins[horizon] / testCount : 0,
    trainExpectancy: trainCount ? bucket.trainSum[horizon] / trainCount : 0,
    testExpectancy: testCount ? bucket.testSum[horizon] / testCount : 0,
    isSignificant: significant,
    calculatedAt: new Date(),
    metadata: { source: "professional-pattern-discovery", exitSampleCount: bucket.exitSamples },
  };
}

async function loadTickers() {
  return db.select({ ticker: moexTickers.secid })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(asc(moexTickers.rank));
}

async function loadRows(ticker: string) {
  return db.select({
    ticker: candles.ticker,
    timestamp: candles.timestamp,
    open: candles.open,
    high: candles.high,
    low: candles.low,
    close: candles.close,
    volume: candles.volume,
  }).from(candles)
    .where(and(eq(candles.ticker, ticker), eq(candles.timeframe, TIMEFRAME)))
    .orderBy(asc(candles.timestamp));
}

async function saveDetections(rows: Candle[], detections: Detection[]) {
  let saved = 0;
  for (let index = 0; index < detections.length; index += 500) {
    const batch = detections.slice(index, index + 500).map((event) => ({
      ticker: rows[0].ticker,
      timeframe: TIMEFRAME,
      startTimestamp: rows[event.start].timestamp,
      endTimestamp: rows[event.end].timestamp,
      patternType: event.type,
      direction: event.direction,
      confidence: event.confidence,
      parameters: event.parameters,
      detectedAt: new Date(),
    }));
    await db.insert(detectedPatterns).values(batch).onConflictDoNothing();
    saved += batch.length;
  }
  return saved;
}

async function saveStatistics(buckets: Map<string, Bucket>) {
  const byTicker = new Map<string, Bucket[]>();
  for (const bucket of buckets.values()) {
    const list = byTicker.get(bucket.ticker) ?? [];
    list.push(bucket);
    byTicker.set(bucket.ticker, list);
  }
  const stats = [];
  for (const [ticker, list] of byTicker) {
    const pValues = list.map((bucket) => {
      const horizon = chooseHorizon(bucket);
      const count = bucket.trainCount[horizon] + bucket.testCount[horizon];
      return { bucket, horizon, p: pValue(bucket.wins[horizon], count) };
    }).sort((a, b) => a.p - b.p);
    let previous = 1;
    const qValues = new Map<string, number>();
    for (let index = pValues.length - 1; index >= 0; index -= 1) {
      const q = Math.min(previous, (pValues[index].p * pValues.length) / (index + 1));
      previous = q;
      qValues.set(bucketKey(ticker, pValues[index].bucket.type, pValues[index].bucket.direction), q);
    }
    stats.push(...pValues.map(({ bucket, horizon }) => buildStats(
      bucket,
      qValues.get(bucketKey(ticker, bucket.type, bucket.direction)) ?? 1,
      horizon,
    )));
  }
  for (let index = 0; index < stats.length; index += 250) {
    const batch = stats.slice(index, index + 250);
    await db.insert(patternStatistics).values(batch).onConflictDoUpdate({
      target: [patternStatistics.ticker, patternStatistics.timeframe, patternStatistics.patternType, patternStatistics.direction],
      set: {
        occurrences: sql`excluded.occurrences`,
        winRate: sql`excluded.win_rate`,
        profitFactor: sql`excluded.profit_factor`,
        expectancy: sql`excluded.expectancy`,
        averageProfit: sql`excluded.average_profit`,
        averageLoss: sql`excluded.average_loss`,
        maxDrawdown: sql`excluded.max_drawdown`,
        bestTakeProfit: sql`excluded.best_take_profit`,
        bestStopLoss: sql`excluded.best_stop_loss`,
        bestHoldingMinutes: sql`excluded.best_holding_minutes`,
        pValue: sql`excluded.p_value`,
        qValue: sql`excluded.q_value`,
        confidenceLow: sql`excluded.confidence_low`,
        confidenceHigh: sql`excluded.confidence_high`,
        trainWinRate: sql`excluded.train_win_rate`,
        testWinRate: sql`excluded.test_win_rate`,
        trainExpectancy: sql`excluded.train_expectancy`,
        testExpectancy: sql`excluded.test_expectancy`,
        isSignificant: sql`excluded.is_significant`,
        calculatedAt: sql`excluded.calculated_at`,
        metadata: sql`excluded.metadata`,
      },
    });
  }
  return stats.length;
}

async function main() {
  const allTickers = await loadTickers();
  const offset = integerArg("offset", 0);
  const maxTickers = integerArg("max-tickers", allTickers.length);
  const tickers = allTickers.slice(offset, offset + maxTickers);
  let detectionCount = 0;
  let savedCount = 0;
  let savedStats = 0;
  for (const { ticker } of tickers) {
    const buckets = new Map<string, Bucket>();
    const rows = (await loadRows(ticker)) as Candle[];
    if (rows.length < 100) continue;
    const detections = detect(rows);
    savedCount += await saveDetections(rows, detections);
    for (const event of detections) {
      const key = bucketKey(ticker, event.type, event.direction);
      const bucket = buckets.get(key) ?? makeBucket(ticker, event.type, event.direction, event.start, event.end);
      updateBucket(bucket, rows, event, Math.floor(rows.length * 0.7));
      buckets.set(key, bucket);
    }
    detectionCount += detections.length;
    savedStats += await saveStatistics(buckets);
    console.log(`${ticker}: ${rows.length} свечей, найдено ${detections.length} паттернов`);
  }
  console.log(`Профессиональные паттерны: найдено ${detectionCount}, новых фактов сохранено ${savedCount}, статистик ${savedStats}`);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});