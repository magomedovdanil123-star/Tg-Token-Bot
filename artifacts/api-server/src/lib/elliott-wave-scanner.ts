import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export const WAVE_TIMEFRAMES = ["30m", "1h"] as const;
type WaveTimeframe = (typeof WAVE_TIMEFRAMES)[number];
type Direction = "BUY" | "SELL";
type PivotKind = "high" | "low";

const MIN_TARGET_PERCENT = 0.5;
const MIN_STOP_PERCENT = 0.5;
const TRANSACTION_COST_PERCENT = 0.2;
// MOEX candles can legitimately pause overnight and around session boundaries.
// Keep the live scan available through that gap without treating a multi-day
// stale series as current.
const MAX_AGE_MINUTES: Record<WaveTimeframe, number> = { "30m": 720, "1h": 720 };
const MAX_BARS_PER_SERIES = 2400;
const BACKTEST_START_BARS = 120;
const COOLDOWN_BARS: Record<WaveTimeframe, number> = { "30m": 8, "1h": 6 };
const CURRENT_SIGNAL_BARS: Record<WaveTimeframe, number> = { "30m": 4, "1h": 3 };

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
  setupType: "elliott";
  scenario: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  targetPercent: number;
  stopPercent: number;
  invalidationPrice: number;
  confidence: number;
  fibonacci: FibonacciInfo | null;
  relativeVolume: number | null;
  reasons: string[];
  historical: WaveHistoricalStats;
};

export type ElliottScanResult = {
  analyzed: number;
  series: number;
  freshSeries: number;
  totalCandidates: number;
  candidates: ElliottCandidate[];
  unavailable: string[];
  generatedAt: Date;
};

export type WaveBacktestTrade = {
  ticker: string;
  timeframe: WaveTimeframe;
  timestamp: Date;
  direction: Direction;
  scenario: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  targetPercent: number;
  stopPercent: number;
  rewardRisk: number;
  relativeVolume: number | null;
  retracement: number | null;
  momentumPercent: number;
  bodyRatio: number;
  rsi: number | null;
  atrPercent: number | null;
  trendAligned: boolean;
  confidence: number;
  outcome: "TP" | "SL" | "TIMEOUT" | "OPEN_AT_END";
  outcomePercent: number;
  pnlRub: number;
  exitTimestamp: Date;
};

export type WaveBacktestResult = {
  periodStart: Date;
  periodEnd: Date;
  stakePerTrade: number;
  totalSignals: number;
  totalNotional: number;
  wins: number;
  losses: number;
  timeouts: number;
  openAtEnd: number;
  winRate: number | null;
  averageOutcomePercent: number | null;
  profitFactor: number | null;
  totalPnlRub: number;
  endingBalanceRub: number;
  maxDrawdownRub: number;
  trades: WaveBacktestTrade[];
};

type WaveBacktestOptions = {
  days?: number;
  stakePerTrade?: number;
  asOf?: Date;
  minConfidence?: number;
  minRelativeVolume?: number;
  minTargetPercent?: number;
  maxStopPercent?: number;
  minRewardRisk?: number;
  timeframes?: WaveTimeframe[];
  directions?: Direction[];
  scenarios?: string[];
  maxSignalsPerBucket?: number;
  targetPercentOverride?: number;
  stopPercentOverride?: number;
  holdingBars?: number;
  minDirectionalMomentumPercent?: number;
  minBodyRatio?: number;
  cooldownBars?: number;
  requireTrendAlignment?: boolean;
  minRsi?: number;
  maxRsi?: number;
  minAtrPercent?: number;
  maxAtrPercent?: number;
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
  const result: Pivot[] = [];
  for (let confirmationIndex = 0; confirmationIndex < rows.length; confirmationIndex += 1) {
    appendConfirmedPivot(rows, confirmationIndex, timeframe, result);
  }
  return result;
}

function appendConfirmedPivot(
  rows: Candle[],
  confirmationIndex: number,
  timeframe: WaveTimeframe,
  result: Pivot[],
) {
  const lookback = pivotLookback(timeframe);
  const pivotIndex = confirmationIndex - lookback;
  if (pivotIndex < lookback) return;
  const row = rows[pivotIndex];
  const before = rows.slice(pivotIndex - lookback, pivotIndex);
  const after = rows.slice(pivotIndex + 1, confirmationIndex + 1);
  if (after.length < lookback) return;
  const isHigh =
    before.every((item) => item.high <= row.high) &&
    after.every((item) => item.high <= row.high);
  const isLow =
    before.every((item) => item.low >= row.low) &&
    after.every((item) => item.low >= row.low);
  if (isHigh === isLow) return;

  const pivot: Pivot = {
    index: pivotIndex,
    confirmationIndex,
    kind: isHigh ? "high" : "low",
    price: isHigh ? row.high : row.low,
  };
  const swingPercent = minSwingPercent(timeframe);
  {
    const previous = result.at(-1);
    if (!previous) {
      result.push(pivot);
      return;
    }
    if (previous.kind === pivot.kind) {
      const moreExtreme =
        pivot.kind === "high" ? pivot.price >= previous.price : pivot.price <= previous.price;
      if (moreExtreme) result[result.length - 1] = pivot;
      return;
    }
    const movement = Math.abs(pct(previous.price, pivot.price));
    if (movement >= swingPercent) result.push(pivot);
  }
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

function candleBodyRatio(rows: Candle[], index: number) {
  const candle = rows[index];
  const range = candle.high - candle.low;
  return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
}

function momentumPercent(rows: Candle[], index: number, timeframe: WaveTimeframe) {
  const lookback = timeframe === "30m" ? 8 : 4;
  const previous = rows[index - lookback]?.close;
  return previous ? pct(previous, rows[index].close) : 0;
}

function indicatorSnapshot(rows: Candle[], index: number, direction: Direction) {
  const start = Math.max(1, index - 220);
  let ema20 = rows[start - 1]?.close ?? rows[index].close;
  let ema50 = ema20;
  let ema200 = ema20;
  for (let cursor = start; cursor <= index; cursor += 1) {
    const close = rows[cursor].close;
    ema20 = close * (2 / 21) + ema20 * (1 - 2 / 21);
    ema50 = close * (2 / 51) + ema50 * (1 - 2 / 51);
    ema200 = close * (2 / 201) + ema200 * (1 - 2 / 201);
  }
  const rsiStart = Math.max(1, index - 14 + 1);
  let gains = 0;
  let losses = 0;
  for (let cursor = rsiStart; cursor <= index; cursor += 1) {
    const change = rows[cursor].close - rows[cursor - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const rsi = losses === 0 ? (gains > 0 ? 100 : 50) : 100 - 100 / (1 + gains / losses);
  let trueRange = 0;
  const atrStart = Math.max(1, index - 14 + 1);
  for (let cursor = atrStart; cursor <= index; cursor += 1) {
    const previousClose = rows[cursor - 1].close;
    trueRange += Math.max(
      rows[cursor].high - rows[cursor].low,
      Math.abs(rows[cursor].high - previousClose),
      Math.abs(rows[cursor].low - previousClose),
    );
  }
  const atrPercent = rows[index].close > 0
    ? (trueRange / Math.max(1, index - atrStart + 1) / rows[index].close) * 100
    : null;
  const trendAligned = direction === "BUY"
    ? rows[index].close > ema20 && ema20 > ema50
    : rows[index].close < ema20 && ema20 < ema50;
  return { rsi, atrPercent, trendAligned };
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
    _setupType: string,
    scenario: string,
    p0: Pivot,
    p1: Pivot,
    p2: Pivot,
    entryBreak: number,
    target: number,
    invalidation: number,
    fib: FibonacciInfo,
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
    const candidate = makeCandidate({
      ticker: rows[index].ticker,
      timeframe,
      timestamp: current.timestamp,
      direction: "BUY",
      setupType: "elliott",
      scenario,
      entryPrice: current.close,
      targetPrice: target,
      stopPrice: stop,
      invalidationPrice: invalidation,
      confidence: 55 + (fib.retracement !== null && fib.retracement >= 0.382 && fib.retracement <= 0.786 ? 12 : 0) + (volume !== null && volume >= 1.2 ? 10 : 0),
      fibonacci: fib,
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
      confidence: 55 + (fib.retracement !== null && fib.retracement >= 0.382 && fib.retracement <= 0.786 ? 12 : 0) + (volume !== null && volume >= 1.2 ? 10 : 0),
      fibonacci: fib,
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
        relativeVolume: volume,
        reasons: ["структура ABC с более высоким максимумом", "пробой основания волны B", `Fibonacci: ${fib.retracementZone}`],
      });
      if (candidate) output.push(candidate);
    }
  }
  return output;
}

function detectAt(rows: Candle[], index: number, timeframe: WaveTimeframe, pivots: Pivot[]) {
  const candidates = impulseCandidates(rows, index, timeframe, pivots);
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
    statisticallyValid: results.length > 0 && (average(net) ?? -Infinity) > 0,
  };
}

function statsKey(candidate: RawCandidate) {
  return `${candidate.timeframe}:${candidate.setupType}:${candidate.direction}:${candidate.scenario}`;
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
    const pivots: Pivot[] = [];
    let lastEventIndex = -Infinity;
    const start = Math.max(BACKTEST_START_BARS, item.candles.length - 1700);
    for (let index = 0; index < item.candles.length; index += 1) {
      appendConfirmedPivot(item.candles, index, item.timeframe, pivots);
      if (index < start) continue;
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
      const firstCurrentIndex = Math.max(
        BACKTEST_START_BARS,
        item.candles.length - CURRENT_SIGNAL_BARS[item.timeframe],
      );
      for (let currentIndex = firstCurrentIndex; currentIndex < item.candles.length; currentIndex += 1) {
        const detected = detectAt(item.candles, currentIndex, item.timeframe, pivots);
        currentCandidates.push(...detected);
      }
    }
  }

  const uniqueCandidates = new Map<string, RawCandidate>();
  for (const candidate of currentCandidates) {
    const key = `${candidate.ticker}:${candidate.timeframe}:${candidate.direction}:${candidate.scenario}`;
    const previous = uniqueCandidates.get(key);
    if (!previous || candidate.confidence > previous.confidence || candidate.timestamp > previous.timestamp) {
      uniqueCandidates.set(key, candidate);
    }
  }
  const candidates = [...uniqueCandidates.values()]
    .map((candidate) => attachStats(candidate, stats))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  return {
    analyzed,
    series: series.length,
    freshSeries,
    totalCandidates: uniqueCandidates.size,
    candidates,
    unavailable,
    generatedAt: new Date(),
  };
}

export async function backtestElliottWaveMonth(options?: WaveBacktestOptions): Promise<WaveBacktestResult> {
  const days = options?.days ?? 30;
  const stakePerTrade = options?.stakePerTrade ?? 100_000;
  const periodEnd = options?.asOf ?? new Date();
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60_000);
  const historyStart = new Date(periodStart.getTime() - 120 * 24 * 60 * 60_000);
  const result = await db.execute(sql`
    SELECT c.ticker, c.timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume
    FROM candles c
    INNER JOIN moex_tickers t ON t.secid = c.ticker AND t.is_active = true
    WHERE c.timeframe IN ('30m', '1h')
      AND c.timestamp >= ${historyStart}
      AND c.timestamp <= ${periodEnd}
    ORDER BY c.ticker, c.timeframe, c.timestamp
  `);
  const series = parseSeries(result.rows as Record<string, unknown>[]);
  const candidateEvents: {
    candidate: RawCandidate;
    item: Series;
    index: number;
    bucket: number;
  }[] = [];
  const seen = new Set<string>();
  for (const item of series) {
    if (item.candles.length < BACKTEST_START_BARS) continue;
    const pivots: Pivot[] = [];
    const periodStartIndex = item.candles.findIndex(
      (candle) => candle.timestamp >= periodStart,
    );
    const startIndex = Math.max(
      BACKTEST_START_BARS,
      periodStartIndex < 0
        ? item.candles.length
        : periodStartIndex - CURRENT_SIGNAL_BARS[item.timeframe],
    );
    for (let index = 0; index < item.candles.length; index += 1) {
      appendConfirmedPivot(item.candles, index, item.timeframe, pivots);
      if (index < startIndex) continue;
      const timestamp = item.candles[index].timestamp;
      if (timestamp < periodStart || timestamp > periodEnd) continue;
      for (const candidate of detectAt(item.candles, index, item.timeframe, pivots)) {
        const momentum = momentumPercent(item.candles, index, item.timeframe);
        const directionalMomentum = candidate.direction === "BUY" ? momentum : -momentum;
        const bodyRatio = candleBodyRatio(item.candles, index);
        const indicators = indicatorSnapshot(item.candles, index, candidate.direction);
        const targetPercent = options?.targetPercentOverride ?? candidate.targetPercent;
        const stopPercent = options?.stopPercentOverride ?? candidate.stopPercent;
        const rewardRisk = stopPercent > 0 ? targetPercent / stopPercent : 0;
        if (options?.minConfidence !== undefined && candidate.confidence < options.minConfidence) continue;
        if (
          options?.minRelativeVolume !== undefined &&
          (candidate.relativeVolume === null || candidate.relativeVolume < options.minRelativeVolume)
        ) continue;
        if (options?.minTargetPercent !== undefined && targetPercent < options.minTargetPercent) continue;
        if (options?.maxStopPercent !== undefined && stopPercent > options.maxStopPercent) continue;
        if (options?.minRewardRisk !== undefined && rewardRisk < options.minRewardRisk) continue;
        if (
          options?.minDirectionalMomentumPercent !== undefined &&
          directionalMomentum < options.minDirectionalMomentumPercent
        ) continue;
        if (options?.minBodyRatio !== undefined && bodyRatio < options.minBodyRatio) continue;
        if (options?.requireTrendAlignment && !indicators.trendAligned) continue;
        if (options?.minRsi !== undefined && indicators.rsi < options.minRsi) continue;
        if (options?.maxRsi !== undefined && indicators.rsi > options.maxRsi) continue;
        if (
          options?.minAtrPercent !== undefined &&
          (indicators.atrPercent === null || indicators.atrPercent < options.minAtrPercent)
        ) continue;
        if (
          options?.maxAtrPercent !== undefined &&
          (indicators.atrPercent === null || indicators.atrPercent > options.maxAtrPercent)
        ) continue;
        if (options?.timeframes && !options.timeframes.includes(candidate.timeframe)) continue;
        if (options?.directions && !options.directions.includes(candidate.direction)) continue;
        if (options?.scenarios && !options.scenarios.includes(candidate.scenario)) continue;
        const key = `${candidate.ticker}:${candidate.timeframe}:${candidate.direction}:${candidate.scenario}:${candidate.timestamp.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidateEvents.push({
          candidate,
          item,
          index,
          bucket: Math.floor(candidate.timestamp.getTime() / (30 * 60_000)),
        });
      }
    }
  }

  const eventBuckets = new Map<number, typeof candidateEvents>();
  for (const event of candidateEvents) {
    const bucket = eventBuckets.get(event.bucket) ?? [];
    bucket.push(event);
    eventBuckets.set(event.bucket, bucket);
  }
  const trades: WaveBacktestTrade[] = [];
  const lastSelected = new Map<string, number>();
  for (const bucketEvents of [...eventBuckets.values()].sort(
    (a, b) => a[0].bucket - b[0].bucket,
  )) {
    const selectedEvents: typeof candidateEvents = [];
    for (const event of bucketEvents.sort(
      (a, b) => b.candidate.confidence - a.candidate.confidence,
    )) {
      if (selectedEvents.length >= (options?.maxSignalsPerBucket ?? 5)) break;
      const key = `${event.candidate.ticker}:${event.candidate.timeframe}:${event.candidate.direction}:${event.candidate.scenario}`;
      const previousIndex = lastSelected.get(key);
      if (
        previousIndex !== undefined &&
        event.index - previousIndex < (options?.cooldownBars ?? 0)
      ) {
        continue;
      }
      selectedEvents.push(event);
      lastSelected.set(key, event.index);
    }
    for (const event of selectedEvents) {
      const { candidate, item, index } = event;
      const targetPercent = options?.targetPercentOverride ?? candidate.targetPercent;
      const stopPercent = options?.stopPercentOverride ?? candidate.stopPercent;
      const targetPrice = candidate.direction === "BUY"
        ? candidate.entryPrice * (1 + targetPercent / 100)
        : candidate.entryPrice * (1 - targetPercent / 100);
      const stopPrice = candidate.direction === "BUY"
        ? candidate.entryPrice * (1 - stopPercent / 100)
        : candidate.entryPrice * (1 + stopPercent / 100);
      const rewardRisk = stopPercent > 0 ? targetPercent / stopPercent : 0;
      const momentum = momentumPercent(item.candles, index, candidate.timeframe);
      const bodyRatio = candleBodyRatio(item.candles, index);
      const indicators = indicatorSnapshot(item.candles, index, candidate.direction);
      if (index < 0) continue;
      const maxIndex = Math.min(
        item.candles.length - 1,
        index + (options?.holdingBars ?? timeframeBars(candidate.timeframe)),
      );
      let outcome: WaveBacktestTrade["outcome"] = "OPEN_AT_END";
      let outcomePercent: number | undefined;
      let exitIndex = maxIndex;
      for (let next = index + 1; next <= maxIndex; next += 1) {
        const candle = item.candles[next];
        const targetHit = candidate.direction === "BUY"
          ? candle.high >= targetPrice
          : candle.low <= targetPrice;
        const stopHit = candidate.direction === "BUY"
          ? candle.low <= stopPrice
          : candle.high >= stopPrice;
        if (targetHit || stopHit) {
          const isWin = targetHit && !stopHit;
          const exit = isWin ? targetPrice : stopPrice;
          outcome = isWin ? "TP" : "SL";
          outcomePercent = positivePct(candidate.direction, candidate.entryPrice, exit) - TRANSACTION_COST_PERCENT;
          exitIndex = next;
          break;
        }
        if (
          next === maxIndex &&
          maxIndex === index + (options?.holdingBars ?? timeframeBars(candidate.timeframe))
        ) {
          outcome = "TIMEOUT";
          outcomePercent = positivePct(candidate.direction, candidate.entryPrice, candle.close) - TRANSACTION_COST_PERCENT;
        }
      }
      if (outcomePercent === undefined) {
        const close = item.candles[maxIndex]?.close ?? candidate.entryPrice;
        outcomePercent = positivePct(candidate.direction, candidate.entryPrice, close) - TRANSACTION_COST_PERCENT;
      }
      trades.push({
        ticker: candidate.ticker,
        timeframe: candidate.timeframe,
        timestamp: candidate.timestamp,
        direction: candidate.direction,
        scenario: candidate.scenario,
        entryPrice: candidate.entryPrice,
        targetPrice,
        stopPrice,
        targetPercent,
        stopPercent,
        rewardRisk,
        relativeVolume: candidate.relativeVolume,
        retracement: candidate.fibonacci?.retracement ?? null,
        momentumPercent: candidate.direction === "BUY" ? momentum : -momentum,
        bodyRatio,
        rsi: indicators.rsi,
        atrPercent: indicators.atrPercent,
        trendAligned: indicators.trendAligned,
        confidence: candidate.confidence,
        outcome,
        outcomePercent,
        pnlRub: (outcomePercent / 100) * stakePerTrade,
        exitTimestamp: item.candles[exitIndex]?.timestamp ?? candidate.timestamp,
      });
    }
  }

  const wins = trades.filter((trade) => trade.outcome === "TP").length;
  const losses = trades.filter((trade) => trade.outcome === "SL").length;
  const timeouts = trades.filter((trade) => trade.outcome === "TIMEOUT").length;
  const openAtEnd = trades.filter((trade) => trade.outcome === "OPEN_AT_END").length;
  const closedTrades = trades.filter((trade) => trade.outcome !== "OPEN_AT_END");
  const positive = closedTrades.filter((trade) => trade.outcomePercent > 0).reduce((sum, trade) => sum + trade.outcomePercent, 0);
  const negative = closedTrades.filter((trade) => trade.outcomePercent < 0).reduce((sum, trade) => sum + trade.outcomePercent, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownRub = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTimestamp.getTime() - b.exitTimestamp.getTime())) {
    equity += trade.pnlRub;
    peak = Math.max(peak, equity);
    maxDrawdownRub = Math.max(maxDrawdownRub, peak - equity);
  }
  const totalPnlRub = trades.reduce((sum, trade) => sum + trade.pnlRub, 0);
  return {
    periodStart,
    periodEnd,
    stakePerTrade,
    totalSignals: trades.length,
    totalNotional: trades.length * stakePerTrade,
    wins,
    losses,
    timeouts,
    openAtEnd,
    winRate: closedTrades.length ? (wins / closedTrades.length) * 100 : null,
    averageOutcomePercent: trades.length ? average(trades.map((trade) => trade.outcomePercent)) : null,
    profitFactor: negative < 0 ? positive / Math.abs(negative) : null,
    totalPnlRub,
    endingBalanceRub: stakePerTrade + totalPnlRub,
    maxDrawdownRub,
    trades: trades.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
  };
}
