import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export const WAVE_TIMEFRAMES = ["30m", "1h"] as const;
type WaveTimeframe = (typeof WAVE_TIMEFRAMES)[number];
type Direction = "BUY" | "SELL";
type PivotKind = "high" | "low";

const MIN_TARGET_PERCENT = 0.5;
const MIN_STOP_PERCENT = 0.5;
const TRANSACTION_COST_PERCENT = 0.2;
const MAX_AGE_MINUTES: Record<WaveTimeframe, number> = { "30m": 150, "1h": 270 };
const MAX_BARS_PER_SERIES = 2400;
const BACKTEST_START_BARS = 120;
const COOLDOWN_BARS: Record<WaveTimeframe, number> = { "30m": 8, "1h": 6 };

type Candle = {
  ticker: string;
  timeframe: WaveTimeframe;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Pivot = {
  index: number;
  confirmationIndex: number;
  kind: PivotKind;
  price: number;
};

type FibonacciInfo = {
  anchorStart: number;
  anchorEnd: number;
  retracement: number | null;
  retracementZone: string;
  extension: number | null;
  levels: { ratio: number; price: number }[];
};

type BacktestResult = {
  result: "WIN" | "LOSS" | "TIMEOUT";
  netPercent: number;
};

export type WaveHistoricalStats = {
  occurrences: number;
  wins: number;
  losses: number;
  winRate: number | null;
  testOccurrences: number;
  testWins: number;
  testWinRate: number | null;
  expectancy: number | null;
  testExpectancy: number | null;
  profitFactor: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  averageProfit: number | null;
  averageLoss: number | null;
  maxDrawdown: number | null;
  statisticallyValid: boolean;
};

export type ElliottCandidate = {
  ticker: string;
  timeframe: WaveTimeframe;
  timestamp: Date;
  direction: Direction;
  setupType: "elliott" | "breakout_retest";
  scenario: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  targetPercent: number;
  stopPercent: number;
  invalidationPrice: number;
  confidence: number;
  fibonacci: FibonacciInfo | null;
  levelPrice: number | null;
  levelType: "support" | "resistance" | null;
  relativeVolume: number | null;
  reasons: string[];
  historical: WaveHistoricalStats;
};

export type ElliottScanResult = {
  analyzed: number;
  series: number;
  freshSeries: number;
  candidates: ElliottCandidate[];
  unavailable: string[];
  generatedAt: Date;
};

type Series = {
  ticker: string;
  timeframe: WaveTimeframe;
  candles: Candle[];
};

type RawCandidate = Omit<ElliottCandidate, "historical">;

type StatAccumulator = {
  results: { timestamp: Date; netPercent: number; result: BacktestResult["result"] }[];
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pct(from: number, to: number) {
  return from ? ((to - from) / from) * 100 : 0;
}

function positivePct(direction: Direction, entry: number, exit: number) {
  return direction === "BUY" ? pct(entry, exit) : pct(exit, entry);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timeframeBars(timeframe: WaveTimeframe) {
  return timeframe === "30m" ? 48 : 24;
}

function minSwingPercent(timeframe: WaveTimeframe) {
  return timeframe === "30m" ? 0.45 : 0.7;
}

function pivotLookback(timeframe: WaveTimeframe) {
  return timeframe === "30m" ? 3 : 2;
}

function roundPrice(value: number) {
  return Number(value.toFixed(6));
}

function upperBound(pivots: Pivot[], index: number) {
  let low = 0;
  let high = pivots.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (pivots[middle].confirmationIndex <= index) low = middle + 1;
    else high = middle;
  }
  return low;
}

function confirmedPivots(rows: Candle[], timeframe: WaveTimeframe): Pivot[] {
  const lookback = pivotLookback(timeframe);
  const swingPercent = minSwingPercent(timeframe);
  const raw: Pivot[] = [];
  for (let index = lookback; index < rows.length - lookback; index += 1) {
    const row = rows[index];
    const before = rows.slice(index - lookback, index);
    const after = rows.slice(index + 1, index + lookback + 1);
    const isHigh =
      before.every((item) => item.high <= row.high) &&
      after.every((item) => item.high <= row.high);
    const isLow =
      before.every((item) => item.low >= row.low) &&
      after.every((item) => item.low >= row.low);
    if (isHigh === isLow) continue;
    raw.push({
      index,
      confirmationIndex: index + lookback,
      kind: isHigh ? "high" : "low",
      price: isHigh ? row.high : row.low,
    });
  }

  const result: Pivot[] = [];
  for (const pivot of raw) {
    const previous = result.at(-1);
    if (!previous) {
      result.push(pivot);
      continue;
    }
    if (previous.kind === pivot.kind) {
      const moreExtreme =
        pivot.kind === "high" ? pivot.price >= previous.price : pivot.price <= previous.price;
      if (moreExtreme) result[result.length - 1] = pivot;
      continue;
    }
    const movement = Math.abs(pct(previous.price, pivot.price));
    if (movement >= swingPercent) result.push(pivot);
  }
  return result;
}

function fibonacci(
  start: number,
  end: number,
  current: number,
  direction: Direction,
  extensionPrice: number,
): FibonacciInfo {
  const distance = Math.abs(end - start);
  const retracement =
    distance > 0
      ? direction === "BUY"
        ? (end - current) / distance
        : (current - end) / distance
      : null;
  const ratios = [0.382, 0.5, 0.618, 0.786];
  const levels = ratios.map((ratio) => ({
    ratio,
    price: roundPrice(
      direction === "BUY" ? end - distance * ratio : end + distance * ratio,
    ),
  }));
  const nearest = retracement === null
    ? null
    : ratios.reduce((best, ratio) =>
        Math.abs(ratio - retracement) < Math.abs(best - retracement) ? ratio : best,
      ratios[0]);
  const zone =
    nearest === null
      ? "нет данных"
      : nearest === 0.618 || nearest === 0.786
        ? "глубокая коррекция 0.618–0.786"
        : nearest === 0.5
          ? "средняя коррекция 0.5"
          : "мелкая коррекция 0.382";
  const extension = distance > 0 ? Math.abs(extensionPrice - end) / distance : null;
  return {
    anchorStart: roundPrice(start),
    anchorEnd: roundPrice(end),
    retracement,
    retracementZone: zone,
    extension,
    levels,
  };
}

function relativeVolume(rows: Candle[], index: number) {
  const values = rows.slice(Math.max(0, index - 20), index).map((row) => row.volume).filter(finite);
  const baseline = average(values);
  return baseline && baseline > 0 ? rows[index].volume / baseline : null;
}

function nearbyLevel(rows: Candle[], index: number, direction: Direction) {
  const window = rows.slice(Math.max(0, index - 50), index);
  if (!window.length) return { price: null, type: null as "support" | "resistance" | null };
  if (direction === "BUY") {
    const support = Math.max(...window.map((row) => row.low).filter((value) => value < rows[index].close));
    return Number.isFinite(support) ? { price: support, type: "support" as const } : { price: null, type: null };
  }
  const resistance = Math.min(...window.map((row) => row.high).filter((value) => value > rows[index].close));
  return Number.isFinite(resistance)
    ? { price: resistance, type: "resistance" as const }
    : { price: null, type: null };
}

function validTrade(direction: Direction, entry: number, target: number, stop: number) {
  const targetPercent = Math.abs(positivePct(direction, entry, target));
  const stopPercent = Math.abs(positivePct(direction, entry, stop));
  return (
    Number.isFinite(target) &&
    Number.isFinite(stop) &&
    targetPercent >= MIN_TARGET_PERCENT &&
    stopPercent >= MIN_STOP_PERCENT &&
    (direction === "BUY" ? target > entry && stop < entry : target < entry && stop > entry)
  );
}

function makeCandidate(
  base: Omit<RawCandidate, "targetPercent" | "stopPercent" | "confidence" | "reasons"> & {
    reasons: string[];
    confidence: number;
  },
): RawCandidate | null {
  const targetPercent = Math.abs(positivePct(base.direction, base.entryPrice, base.targetPrice));
  const stopPercent = Math.abs(positivePct(base.direction, base.entryPrice, base.stopPrice));
  if (!validTrade(base.direction, base.entryPrice, base.targetPrice, base.stopPrice)) return null;
  return {
    ...base,
    targetPercent,
    stopPercent,
    confidence: Math.max(0, Math.min(100, base.confidence)),
  };
}

function impulseCandidates(
  rows: Candle[],
  index: number,
  timeframe: WaveTimeframe,
  pivots: Pivot[],
): RawCandidate[] {
  const count = upperBound(pivots, index);
  const recent = pivots.slice(Math.max(0, count - 6));
  const current = rows[index];
  const output: RawCandidate[] = [];
  const volume = relativeVolume(rows, index);

  const addBull = (
    setupType: string,
    scenario: string,
    p0: Pivot,
    p1: Pivot,
    p2: Pivot,
    entryBreak: number,
    target: number,
    invalidation: number,
    fib: FibonacciInfo,
    level: ReturnType<typeof nearbyLevel>,
  ) => {
    if (p0.kind !== "low" || p1.kind !== "high" || p2.kind !== "low") return;
    if (p2.price <= p0.price || current.close <= entryBreak * 1.0003) return;
    const stop = Math.min(p2.price * 0.995, p2.price - (p1.price - p0.price) * 0.12);
    const reasons = [
      "подтверждённая последовательность бычьих swing-точек",
      scenario,
      `Fibonacci: ${fib.retracementZone}`,
    ];
    if (volume !== null && volume >= 1.2) reasons.push(`объём пробоя выше среднего (${volume.toFixed(2)}x)`);
    if (level.price !== null) reasons.push(`рядом поддержка ${level.price.toFixed(2)}`);
    const candidate = makeCandidate({
      ticker: rows[index].ticker,
      timeframe,
      timestamp: current.timestamp,
      direction: "BUY",
      setupType: setupType === "breakout_retest" ? "breakout_retest" : "elliott",
      scenario,
      entryPrice: current.close,
      targetPrice: target,
      stopPrice: stop,
      invalidationPrice: invalidation,
      confidence: 55 + (fib.retracement !== null && fib.retracement >= 0.382 && fib.retracement <= 0.786 ? 12 : 0) + (volume !== null && volume >= 1.2 ? 10 : 0) + (level.price !== null ? 6 : 0),
      fibonacci: fib,
      levelPrice: level.price,
      levelType: level.type,
      relativeVolume: volume,
      reasons,
    });
    if (candidate) output.push(candidate);
  };

  const addBear = (
    scenario: string,
    p0: Pivot,
    p1: Pivot,
    p2: Pivot,
    entryBreak: number,
    target: number,
    invalidation: number,
    fib: FibonacciInfo,
    level: ReturnType<typeof nearbyLevel>,
  ) => {
    if (p0.kind !== "high" || p1.kind !== "low" || p2.kind !== "high") return;
    if (p2.price >= p0.price || current.close >= entryBreak * 0.9997) return;
    const stop = Math.max(p2.price * 1.005, p2.price + (p0.price - p1.price) * 0.12);
    const reasons = [
      "подтверждённая последовательность медвежьих swing-точек",
      scenario,
      `Fibonacci: ${fib.retracementZone}`,
    ];
    if (volume !== null && volume >= 1.2) reasons.push(`объём пробоя выше среднего (${volume.toFixed(2)}x)`);
    if (level.price !== null) reasons.push(`рядом сопротивление ${level.price.toFixed(2)}`);
    const candidate = makeCandidate({
      ticker: rows[index].ticker,
      timeframe,
      timestamp: current.timestamp,
      direction: "SELL",
      setupType: "elliott",
      scenario,
      entryPrice: current.close,
      targetPrice: target,
      stopPrice: stop,
      invalidationPrice: invalidation,
      confidence: 55 + (fib.retracement !== null && fib.retracement >= 0.382 && fib.retracement <= 0.786 ? 12 : 0) + (volume !== null && volume >= 1.2 ? 10 : 0) + (level.price !== null ? 6 : 0),
      fibonacci: fib,
      levelPrice: level.price,
      levelType: level.type,
      relativeVolume: volume,
      reasons,
    });
    if (candidate) output.push(candidate);
  };

  if (recent.length >= 3) {
    const [p0, p1, p2] = recent.slice(-3);
    if (p0.kind === "low" && p1.kind === "high" && p2.kind === "low") {
      const range = p1.price - p0.price;
      const retrace = range > 0 ? (p1.price - p2.price) / range : 0;
      if (retrace >= 0.236 && retrace <= 0.786) {
        const target = p2.price + range * 1.618;
        addBull(
          "elliott",
          "возможное завершение волны 2 и начало волны 3",
          p0,
          p1,
          p2,
          p1.price,
          target,
          p0.price,
          fibonacci(p0.price, p1.price, p2.price, "BUY", target),
          nearbyLevel(rows, index, "BUY"),
        );
      }
    }
    if (p0.kind === "high" && p1.kind === "low" && p2.kind === "high") {
      const range = p0.price - p1.price;
      const retrace = range > 0 ? (p2.price - p1.price) / range : 0;
      if (retrace >= 0.236 && retrace <= 0.786) {
        const target = p2.price - range * 1.618;
        addBear(
          "возможное завершение волны 2 и начало волны 3",
          p0,
          p1,
          p2,
          p1.price,
          target,
          p0.price,
          fibonacci(p0.price, p1.price, p2.price, "SELL", target),
          nearbyLevel(rows, index, "SELL"),
        );
      }
    }
  }

  if (recent.length >= 5) {
    const [p0, p1, p2, p3, p4] = recent.slice(-5);
    if (
      p0.kind === "low" && p1.kind === "high" && p2.kind === "low" &&
      p3.kind === "high" && p4.kind === "low" &&
      p2.price > p0.price && p3.price > p1.price && p4.price > p2.price &&
      current.close > p3.price * 1.0003
    ) {
      const wave3 = p3.price - p2.price;
      const target = p4.price + Math.max(wave3 * 0.618, (p1.price - p0.price) * 1.0);
      addBull(
        "elliott",
        "возможное завершение волны 4 и начало волны 5",
        p2,
        p3,
        p4,
        p3.price,
        target,
        p1.price,
        fibonacci(p2.price, p3.price, p4.price, "BUY", target),
        nearbyLevel(rows, index, "BUY"),
      );
    }
    if (
      p0.kind === "high" && p1.kind === "low" && p2.kind === "high" &&
      p3.kind === "low" && p4.kind === "high" &&
      p2.price < p0.price && p3.price < p1.price && p4.price < p2.price &&
      current.close < p3.price * 0.9997
    ) {
      const wave3 = p2.price - p3.price;
      const target = p4.price - Math.max(wave3 * 0.618, (p0.price - p1.price) * 1.0);
      addBear(
        "возможное завершение волны 4 и начало волны 5",
        p2,
        p3,
        p4,
        p3.price,
        target,
        p1.price,
        fibonacci(p3.price, p2.price, p4.price, "SELL", target),
        nearbyLevel(rows, index, "SELL"),
      );
    }
  }

  if (recent.length >= 4) {
    const [p0, p1, p2, p3] = recent.slice(-4);
    if (
      p0.kind === "high" && p1.kind === "low" && p2.kind === "high" && p3.kind === "low" &&
      p2.price < p0.price && p3.price < p1.price && current.close > p2.price * 1.0003
    ) {
      const a = p0.price - p1.price;
      const target = p3.price + a;
      const fib = fibonacci(p0.price, p1.price, p3.price, "BUY", target);
      const candidate = makeCandidate({
        ticker: rows[index].ticker,
        timeframe,
        timestamp: current.timestamp,
        direction: "BUY",
        setupType: "elliott",
        scenario: "возможное завершение коррекции ABC и разворот вверх",
        entryPrice: current.close,
        targetPrice: target,
        stopPrice: p3.price * 0.995,
        invalidationPrice: p3.price,
        confidence: 58 + (volume !== null && volume >= 1.2 ? 10 : 0),
        fibonacci: fib,
        ...nearbyLevel(rows, index, "BUY"),
        levelPrice: nearbyLevel(rows, index, "BUY").price,
        levelType: nearbyLevel(rows, index, "BUY").type,
        relativeVolume: volume,
        reasons: ["структура ABC с более низким минимумом", "пробой вершины волны B", `Fibonacci: ${fib.retracementZone}`],
      });
      if (candidate) output.push(candidate);
    }
    if (
      p0.kind === "low" && p1.kind === "high" && p2.kind === "low" && p3.kind === "high" &&
      p2.price > p0.price && p3.price > p1.price && current.close < p2.price * 0.9997
    ) {
      const a = p1.price - p0.price;
      const target = p3.price - a;
      const fib = fibonacci(p0.price, p1.price, p3.price, "SELL", target);
      const level = nearbyLevel(rows, index, "SELL");
      const candidate = makeCandidate({
        ticker: rows[index].ticker,
        timeframe,
        timestamp: current.timestamp,
        direction: "SELL",
        setupType: "elliott",
        scenario: "возможное завершение коррекции ABC и разворот вниз",
        entryPrice: current.close,
        targetPrice: target,
        stopPrice: p3.price * 1.005,
        invalidationPrice: p3.price,
        confidence: 58 + (volume !== null && volume >= 1.2 ? 10 : 0),
        fibonacci: fib,
        levelPrice: level.price,
        levelType: level.type,
        relativeVolume: volume,
        reasons: ["структура ABC с более высоким максимумом", "пробой основания волны B", `Fibonacci: ${fib.retracementZone}`],
      });
      if (candidate) output.push(candidate);
    }
  }
  return output;
}

function breakoutRetestCandidate(rows: Candle[], index: number, timeframe: WaveTimeframe): RawCandidate | null {
  if (index < 35) return null;
  const current = rows[index];
  const searchStart = Math.max(30, index - 10);
  for (let breakoutIndex = index - 8; breakoutIndex <= index - 2; breakoutIndex += 1) {
    const prior = rows.slice(Math.max(0, breakoutIndex - 30), breakoutIndex);
    if (prior.length < 20) continue;
    const resistance = Math.max(...prior.map((row) => row.high));
    const support = Math.min(...prior.map((row) => row.low));
    const breakout = rows[breakoutIndex];
    const vol = relativeVolume(rows, breakoutIndex);
    if (
      breakout.close > resistance * 1.001 &&
      breakoutIndex >= searchStart &&
      rows.slice(breakoutIndex + 1, index).some((row) => row.low <= resistance * 1.004 && row.close >= resistance)
    ) {
      const retestIndex = rows.slice(breakoutIndex + 1, index).findIndex((row) => row.low <= resistance * 1.004 && row.close >= resistance);
      const retest = rows[breakoutIndex + 1 + retestIndex];
      if (retest && current.close > retest.high * 1.0003) {
        const target = current.close + Math.max((current.close - resistance) * 2, current.close * 0.005);
        const stop = resistance * 0.995;
        const fib = fibonacci(resistance, breakout.close, retest.close, "BUY", target);
        return makeCandidate({
          ticker: current.ticker,
          timeframe,
          timestamp: current.timestamp,
          direction: "BUY",
          setupType: "breakout_retest",
          scenario: "пробой сопротивления и подтверждённый ретест",
          entryPrice: current.close,
          targetPrice: target,
          stopPrice: stop,
          invalidationPrice: resistance,
          confidence: 62 + (vol !== null && vol >= 1.2 ? 12 : 0),
          fibonacci: fib,
          levelPrice: resistance,
          levelType: "resistance",
          relativeVolume: vol,
          reasons: ["закрытие выше сопротивления", "ретест уровня сверху", "продолжение после ретеста", ...(vol !== null && vol >= 1.2 ? [`объём пробоя ${vol.toFixed(2)}x`] : [])],
        });
      }
    }
    if (
      breakout.close < support * 0.999 &&
      breakoutIndex >= searchStart &&
      rows.slice(breakoutIndex + 1, index).some((row) => row.high >= support * 0.996 && row.close <= support)
    ) {
      const retestIndex = rows.slice(breakoutIndex + 1, index).findIndex((row) => row.high >= support * 0.996 && row.close <= support);
      const retest = rows[breakoutIndex + 1 + retestIndex];
      if (retest && current.close < retest.low * 0.9997) {
        const target = current.close - Math.max((support - current.close) * 2, current.close * 0.005);
        const stop = support * 1.005;
        const fib = fibonacci(support, breakout.close, retest.close, "SELL", target);
        return makeCandidate({
          ticker: current.ticker,
          timeframe,
          timestamp: current.timestamp,
          direction: "SELL",
          setupType: "breakout_retest",
          scenario: "пробой поддержки и подтверждённый ретест",
          entryPrice: current.close,
          targetPrice: target,
          stopPrice: stop,
          invalidationPrice: support,
          confidence: 62 + (vol !== null && vol >= 1.2 ? 12 : 0),
          fibonacci: fib,
          levelPrice: support,
          levelType: "support",
          relativeVolume: vol,
          reasons: ["закрытие ниже поддержки", "ретест уровня снизу", "продолжение после ретеста", ...(vol !== null && vol >= 1.2 ? [`объём пробоя ${vol.toFixed(2)}x`] : [])],
        });
      }
    }
  }
  return null;
}

function detectAt(rows: Candle[], index: number, timeframe: WaveTimeframe, pivots: Pivot[]) {
  const candidates = impulseCandidates(rows, index, timeframe, pivots);
  const breakout = breakoutRetestCandidate(rows, index, timeframe);
  if (breakout) candidates.push(breakout);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.setupType}:${candidate.direction}:${candidate.scenario}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evaluate(rows: Candle[], index: number, candidate: RawCandidate, timeframe: WaveTimeframe): BacktestResult | null {
  const maxIndex = Math.min(rows.length - 1, index + timeframeBars(timeframe));
  if (maxIndex <= index) return null;
  for (let next = index + 1; next <= maxIndex; next += 1) {
    const candle = rows[next];
    const targetHit = candidate.direction === "BUY"
      ? candle.high >= candidate.targetPrice
      : candle.low <= candidate.targetPrice;
    const stopHit = candidate.direction === "BUY"
      ? candle.low <= candidate.stopPrice
      : candle.high >= candidate.stopPrice;
    if (targetHit || stopHit) {
      const win = targetHit && !stopHit;
      const exit = win ? candidate.targetPrice : candidate.stopPrice;
      const gross = positivePct(candidate.direction, candidate.entryPrice, exit);
      return { result: win ? "WIN" : "LOSS", netPercent: gross - TRANSACTION_COST_PERCENT };
    }
  }
  const close = rows[maxIndex].close;
  return {
    result: "TIMEOUT",
    netPercent: positivePct(candidate.direction, candidate.entryPrice, close) - TRANSACTION_COST_PERCENT,
  };
}

function wilson(wins: number, total: number) {
  if (!total) return { low: null, high: null };
  const z = 1.96;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total));
  return { low: Math.max(0, center - spread) * 100, high: Math.min(1, center + spread) * 100 };
}

function makeStats(accumulator: StatAccumulator | undefined): WaveHistoricalStats {
  const results = accumulator?.results ?? [];
  const wins = results.filter((item) => item.result === "WIN").length;
  const losses = results.filter((item) => item.result === "LOSS").length;
  const ordered = [...results].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const testStart = Math.floor(ordered.length * 0.7);
  const test = ordered.slice(testStart);
  const testWins = test.filter((item) => item.result === "WIN").length;
  const net = results.map((item) => item.netPercent);
  const positive = net.filter((value) => value > 0);
  const negative = net.filter((value) => value < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of net) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const testNet = test.map((item) => item.netPercent);
  const interval = wilson(wins, results.length);
  return {
    occurrences: results.length,
    wins,
    losses,
    winRate: results.length ? (wins / results.length) * 100 : null,
    testOccurrences: test.length,
    testWins,
    testWinRate: test.length ? (testWins / test.length) * 100 : null,
    expectancy: average(net),
    testExpectancy: average(testNet),
    profitFactor: negative.length ? positive.reduce((sum, value) => sum + value, 0) / Math.abs(negative.reduce((sum, value) => sum + value, 0)) : null,
    confidenceLow: interval.low,
    confidenceHigh: interval.high,
    averageProfit: average(positive),
    averageLoss: average(negative),
    maxDrawdown,
    statisticallyValid: results.length >= 20 && test.length >= 8 && (average(testNet) ?? -Infinity) > 0 && (testWins / Math.max(1, test.length)) >= 0.5,
  };
}

function statsKey(candidate: RawCandidate) {
  return `${candidate.ticker}:${candidate.timeframe}:${candidate.setupType}:${candidate.direction}:${candidate.scenario}`;
}

function attachStats(candidate: RawCandidate, stats: Map<string, StatAccumulator>) {
  return { ...candidate, historical: makeStats(stats.get(statsKey(candidate))) };
}

function parseSeries(rows: Record<string, unknown>[]) {
  const byKey = new Map<string, Candle[]>();
  for (const row of rows) {
    const timeframe = String(row.timeframe) as WaveTimeframe;
    if (!WAVE_TIMEFRAMES.includes(timeframe)) continue;
    const candle: Candle = {
      ticker: String(row.ticker),
      timeframe,
      timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp)),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume) || 0,
    };
    if (!Number.isFinite(candle.timestamp.getTime()) || !finite(candle.close)) continue;
    const key = `${candle.ticker}:${timeframe}`;
    const current = byKey.get(key) ?? [];
    current.push(candle);
    byKey.set(key, current);
  }
  return [...byKey.entries()].map(([key, candles]) => {
    const [ticker, timeframe] = key.split(":") as [string, WaveTimeframe];
    return { ticker, timeframe, candles: candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()) };
  });
}

export async function scanElliottWaveStrategies(): Promise<ElliottScanResult> {
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT
        c.ticker,
        c.timeframe,
        c.timestamp,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
        ROW_NUMBER() OVER (PARTITION BY c.ticker, c.timeframe ORDER BY c.timestamp DESC) AS row_number
      FROM candles c
      INNER JOIN moex_tickers t ON t.secid = c.ticker AND t.is_active = true
      WHERE c.timeframe IN ('30m', '1h')
    )
    SELECT ticker, timeframe, timestamp, open, high, low, close, volume
    FROM ranked
    WHERE row_number <= ${MAX_BARS_PER_SERIES}
    ORDER BY ticker, timeframe, timestamp
  `);
  const series = parseSeries(result.rows as Record<string, unknown>[]);
  const stats = new Map<string, StatAccumulator>();
  const currentCandidates: RawCandidate[] = [];
  let analyzed = 0;
  let freshSeries = 0;
  const unavailable: string[] = [];
  const now = Date.now();

  for (const item of series) {
    analyzed += 1;
    const latest = item.candles.at(-1);
    if (!latest || item.candles.length < BACKTEST_START_BARS) {
      unavailable.push(`${item.ticker} ${item.timeframe}: недостаточно свечей`);
      continue;
    }
    const age = (now - latest.timestamp.getTime()) / 60_000;
    const fresh = age <= MAX_AGE_MINUTES[item.timeframe];
    if (fresh) freshSeries += 1;
    const pivots = confirmedPivots(item.candles, item.timeframe);
    let lastEventIndex = -Infinity;
    const start = Math.max(BACKTEST_START_BARS, item.candles.length - 1700);
    for (let index = start; index < item.candles.length; index += 1) {
      const detected = detectAt(item.candles, index, item.timeframe, pivots);
      for (const candidate of detected) {
        if (index - lastEventIndex < COOLDOWN_BARS[item.timeframe]) continue;
        const outcome = evaluate(item.candles, index, candidate, item.timeframe);
        if (!outcome) continue;
        const key = statsKey(candidate);
        const accumulator = stats.get(key) ?? { results: [] };
        accumulator.results.push({ timestamp: candidate.timestamp, netPercent: outcome.netPercent, result: outcome.result });
        stats.set(key, accumulator);
        lastEventIndex = index;
      }
    }
    if (fresh) {
      const detected = detectAt(item.candles, item.candles.length - 1, item.timeframe, pivots);
      currentCandidates.push(...detected);
    }
  }

  const candidates = currentCandidates
    .map((candidate) => attachStats(candidate, stats))
    .filter((candidate) => candidate.historical.statisticallyValid)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);

  return {
    analyzed,
    series: series.length,
    freshSeries,
    candidates,
    unavailable,
    generatedAt: new Date(),
  };
}
