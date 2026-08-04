import { asc, eq, sql } from "drizzle-orm";
import {
  backtestResults,
  candles,
  db,
  featureCombinations,
  moexTickers,
  pool,
  strategyResults,
} from "@workspace/db";

const TIMEFRAME = "10m";
const HOLDING_MINUTES = [30, 60, 120, 240, 720];
const TAKE_PROFITS = [0.25, 0.5, 1, 1.5];
const STOP_LOSSES = [0.25, 0.5, 1, 1.5];
const MIN_OCCURRENCES = 100;
const MIN_SPLIT_OCCURRENCES = 30;
const MAX_SAVED_RESULTS = 100;

type ResearchRow = {
  ticker: string;
  timestamp: Date | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  rsi: number | null;
  ema_20: number | null;
  ema_50: number | null;
  ema_100: number | null;
  ema_200: number | null;
  macd_hist: number | null;
  adx: number | null;
  atr: number | null;
  vwap: number | null;
  bb_upper: number | null;
  bb_middle: number | null;
  bb_lower: number | null;
  bb_width: number | null;
  relative_volume: number | null;
  avg_volume_20: number | null;
  acceleration: number | null;
  price_change_3: number | null;
  price_change_5: number | null;
  body_size: number | null;
  body_to_range: number | null;
  upper_shadow: number | null;
  lower_shadow: number | null;
  green_streak: number | null;
  red_streak: number | null;
  candle_range: number | null;
  historical_volatility: number | null;
  patternKeys: string[];
};

type LocalRow = ResearchRow & { timestampMs: number };

type Factor = {
  key: string;
  label: string;
  matches: (row: LocalRow, quantiles: Quantiles) => boolean;
};

const PROFESSIONAL_PATTERN_FACTORS = [
  ["Hammer", "BUY"], ["Inverted Hammer", "BUY"], ["Hanging Man", "SELL"], ["Shooting Star", "SELL"],
  ["Doji", "BUY"], ["Dragonfly Doji", "BUY"], ["Gravestone Doji", "SELL"], ["Long Legged Doji", "BUY"],
  ["Engulfing Bullish", "BUY"], ["Engulfing Bearish", "SELL"], ["Harami", "BUY"], ["Harami", "SELL"],
  ["Piercing Line", "BUY"], ["Dark Cloud Cover", "SELL"], ["Morning Star", "BUY"], ["Evening Star", "SELL"],
  ["Three White Soldiers", "BUY"], ["Three Black Crows", "SELL"], ["Tweezer Top", "SELL"], ["Tweezer Bottom", "BUY"],
  ["Marubozu", "BUY"], ["Marubozu", "SELL"], ["Spinning Top", "BUY"], ["Spinning Top", "SELL"],
  ["Belt Hold", "BUY"], ["Belt Hold", "SELL"], ["Kicking", "BUY"], ["Kicking", "SELL"],
  ["Rising Three Methods", "BUY"], ["Falling Three Methods", "SELL"],
  ["Double Top", "SELL"], ["Double Bottom", "BUY"], ["Triple Top", "SELL"], ["Triple Bottom", "BUY"],
  ["Ascending Triangle", "BUY"], ["Descending Triangle", "SELL"], ["Symmetrical Triangle", "BUY"], ["Symmetrical Triangle", "SELL"],
  ["Rising Wedge", "SELL"], ["Falling Wedge", "BUY"], ["Flag", "BUY"], ["Flag", "SELL"],
  ["Pennant", "BUY"], ["Pennant", "SELL"], ["Rectangle", "BUY"], ["Rectangle", "SELL"],
  ["Channel", "BUY"], ["Channel", "SELL"], ["Cup and Handle", "BUY"],
  ["Head and Shoulders", "SELL"], ["Inverse Head and Shoulders", "BUY"],
  ["BOS", "BUY"], ["BOS", "SELL"], ["CHOCH", "BUY"], ["CHOCH", "SELL"],
  ["Liquidity Sweep", "BUY"], ["Liquidity Sweep", "SELL"], ["Equal Highs", "SELL"], ["Equal Lows", "BUY"],
  ["Order Block", "BUY"], ["Order Block", "SELL"], ["Breaker Block", "BUY"], ["Breaker Block", "SELL"],
  ["Mitigation Block", "BUY"], ["Mitigation Block", "SELL"], ["Fair Value Gap", "BUY"], ["Fair Value Gap", "SELL"],
  ["Imbalance", "BUY"], ["Imbalance", "SELL"], ["Premium/Discount Zone", "BUY"], ["Premium/Discount Zone", "SELL"],
] as const;

type Quantiles = Record<string, { low: number; high: number }>;

type Direction = "BUY" | "SELL";

type Stat = {
  combo: number[];
  direction: Direction;
  holdingMinutes: number;
  occurrences: number;
  trainOccurrences: number;
  testOccurrences: number;
  wins: number;
  trainWins: number;
  testWins: number;
  sum: number;
  trainSum: number;
  testSum: number;
  positiveSum: number;
  negativeSum: number;
  trainPositiveSum: number;
  trainNegativeSum: number;
  testPositiveSum: number;
  testNegativeSum: number;
  sumSquares: number;
  maxDrawdown: number;
  equityByTicker: Map<string, { equity: number; peak: number; drawdown: number }>;
  periodStartMs: number;
  periodEndMs: number;
};

type Metrics = {
  stat: Stat;
  conditionKey: string;
  conditionLabel: string;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  expectedValue: number;
  profitFactor: number | null;
  pValue: number;
  confidenceLow: number;
  confidenceHigh: number;
  trainWinRate: number;
  testWinRate: number;
  trainExpectedValue: number;
  testExpectedValue: number;
  testProfitFactor: number | null;
  qValue: number;
  bestTakeProfit: number;
  bestStopLoss: number;
  periodStart: Date;
  periodEnd: Date;
};

type ExitStats = {
  count: number;
  trainCount: number;
  testCount: number;
  wins: number;
  trainWins: number;
  testWins: number;
  sum: number;
  trainSum: number;
  testSum: number;
};

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function integerArg(name: string, fallback: number) {
  const value = Number(arg(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function average(values: number[]) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : undefined;
}

function quantile(values: number[], probability: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function numeric(values: (number | null | undefined)[]) {
  return values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t) *
      Math.exp(-absolute * absolute);
  return 0.5 * (1 + sign * polynomial);
}

function twoSidedBinomialPValue(wins: number, total: number) {
  if (total < 2) return 1;
  const standardError = Math.sqrt(0.25 / total);
  const z = Math.abs(wins / total - 0.5) / standardError;
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}

function confidenceInterval(wins: number, total: number) {
  if (!total) return [0, 0] as const;
  const rate = wins / total;
  const z = 1.96;
  const denominator = 1 + (z * z) / total;
  const centre = (rate + (z * z) / (2 * total)) / denominator;
  const spread =
    (z / denominator) *
    Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)] as const;
}

function ratio(value: number | null, close: number) {
  return value !== null && Number.isFinite(value) && close !== 0
    ? (value / close) * 100
    : undefined;
}

function buildQuantiles(rows: LocalRow[]) {
  const values: Record<string, number[]> = {};
  const add = (key: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) (values[key] ??= []).push(value);
  };
  for (const row of rows) {
    add("rsi", row.rsi ?? undefined);
    add("adx", row.adx ?? undefined);
    add("atrPct", ratio(row.atr, row.close));
    add("bbWidth", row.bb_width ?? undefined);
    add("relativeVolume", row.relative_volume ?? undefined);
    add("volume", row.volume ?? undefined);
    add("acceleration", row.acceleration ?? undefined);
    add("speed", row.price_change_5 ?? row.price_change_3 ?? undefined);
    add("rangePct", ratio(row.candle_range, row.close));
    add("bodyPct", ratio(row.body_size, row.close));
    add("bodyToRange", row.body_to_range ?? undefined);
    add("upperShadowPct", ratio(row.upper_shadow, row.candle_range ?? 0));
    add("lowerShadowPct", ratio(row.lower_shadow, row.candle_range ?? 0));
    add("volatility", row.historical_volatility ?? undefined);
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, series]) => [
      key,
      {
        low: quantile(series, 0.2) ?? 0,
        high: quantile(series, 0.8) ?? 0,
      },
    ]),
  ) as Quantiles;
}

function buildFactors(): Factor[] {
  const percentile = (key: string, side: "low" | "high", row: LocalRow, q: Quantiles) => {
    const value = q[key]?.[side];
    return value !== undefined;
  };
  const baseFactors: Factor[] = [
    { key: "price_above_ema20", label: "Цена выше EMA20", matches: (r) => r.ema_20 !== null && r.close > r.ema_20 },
    { key: "price_below_ema20", label: "Цена ниже EMA20", matches: (r) => r.ema_20 !== null && r.close < r.ema_20 },
    { key: "ema20_above_ema50", label: "EMA20 выше EMA50", matches: (r) => r.ema_20 !== null && r.ema_50 !== null && r.ema_20 > r.ema_50 },
    { key: "ema20_below_ema50", label: "EMA20 ниже EMA50", matches: (r) => r.ema_20 !== null && r.ema_50 !== null && r.ema_20 < r.ema_50 },
    { key: "ema50_above_ema200", label: "EMA50 выше EMA200", matches: (r) => r.ema_50 !== null && r.ema_200 !== null && r.ema_50 > r.ema_200 },
    { key: "ema50_below_ema200", label: "EMA50 ниже EMA200", matches: (r) => r.ema_50 !== null && r.ema_200 !== null && r.ema_50 < r.ema_200 },
    { key: "rsi_low", label: "RSI в нижнем квантиле", matches: (r, q) => r.rsi !== null && percentile("rsi", "low", r, q) && r.rsi <= q.rsi.low },
    { key: "rsi_high", label: "RSI в верхнем квантиле", matches: (r, q) => r.rsi !== null && percentile("rsi", "high", r, q) && r.rsi >= q.rsi.high },
    { key: "macd_positive", label: "MACD histogram положительный", matches: (r) => r.macd_hist !== null && r.macd_hist > 0 },
    { key: "macd_negative", label: "MACD histogram отрицательный", matches: (r) => r.macd_hist !== null && r.macd_hist < 0 },
    { key: "adx_high", label: "ADX в верхнем квантиле", matches: (r, q) => r.adx !== null && percentile("adx", "high", r, q) && r.adx >= q.adx.high },
    { key: "adx_low", label: "ADX в нижнем квантиле", matches: (r, q) => r.adx !== null && percentile("adx", "low", r, q) && r.adx <= q.adx.low },
    { key: "atr_high", label: "ATR/цена в верхнем квантиле", matches: (r, q) => { const value = ratio(r.atr, r.close); return value !== undefined && value >= q.atrPct.high; } },
    { key: "atr_low", label: "ATR/цена в нижнем квантиле", matches: (r, q) => { const value = ratio(r.atr, r.close); return value !== undefined && value <= q.atrPct.low; } },
    { key: "above_vwap", label: "Цена выше VWAP", matches: (r) => r.vwap !== null && r.close > r.vwap },
    { key: "below_vwap", label: "Цена ниже VWAP", matches: (r) => r.vwap !== null && r.close < r.vwap },
    { key: "bollinger_low", label: "Нижний диапазон Bollinger", matches: (r) => r.bb_lower !== null && r.close <= r.bb_lower },
    { key: "bollinger_high", label: "Верхний диапазон Bollinger", matches: (r) => r.bb_upper !== null && r.close >= r.bb_upper },
    { key: "bollinger_squeeze", label: "Ширина Bollinger в нижнем квантиле", matches: (r, q) => r.bb_width !== null && r.bb_width <= q.bbWidth.low },
    { key: "bollinger_expansion", label: "Ширина Bollinger в верхнем квантиле", matches: (r, q) => r.bb_width !== null && r.bb_width >= q.bbWidth.high },
    { key: "volume_high", label: "Объём в верхнем квантиле", matches: (r, q) => r.volume !== null && r.volume >= q.volume.high },
    { key: "relative_volume_high", label: "Относительный объём в верхнем квантиле", matches: (r, q) => r.relative_volume !== null && r.relative_volume >= q.relativeVolume.high },
    { key: "relative_volume_low", label: "Относительный объём в нижнем квантиле", matches: (r, q) => r.relative_volume !== null && r.relative_volume <= q.relativeVolume.low },
    { key: "acceleration_high", label: "Ускорение цены в верхнем квантиле", matches: (r, q) => r.acceleration !== null && r.acceleration >= q.acceleration.high },
    { key: "acceleration_low", label: "Ускорение цены в нижнем квантиле", matches: (r, q) => r.acceleration !== null && r.acceleration <= q.acceleration.low },
    { key: "speed_high", label: "Скорость движения в верхнем квантиле", matches: (r, q) => (r.price_change_5 ?? r.price_change_3) !== null && (r.price_change_5 ?? r.price_change_3)! >= q.speed.high },
    { key: "speed_low", label: "Скорость движения в нижнем квантиле", matches: (r, q) => (r.price_change_5 ?? r.price_change_3) !== null && (r.price_change_5 ?? r.price_change_3)! <= q.speed.low },
    { key: "large_candle", label: "Размер свечи в верхнем квантиле", matches: (r, q) => { const value = ratio(r.candle_range, r.close); return value !== undefined && value >= q.rangePct.high; } },
    { key: "small_candle", label: "Размер свечи в нижнем квантиле", matches: (r, q) => { const value = ratio(r.candle_range, r.close); return value !== undefined && value <= q.rangePct.low; } },
    { key: "large_body", label: "Тело свечи в верхнем квантиле", matches: (r, q) => { const value = ratio(r.body_size, r.close); return value !== undefined && value >= q.bodyPct.high; } },
    { key: "upper_shadow_high", label: "Верхняя тень в верхнем квантиле", matches: (r, q) => { const value = ratio(r.upper_shadow, r.candle_range ?? 0); return value !== undefined && value >= q.upperShadowPct.high; } },
    { key: "lower_shadow_high", label: "Нижняя тень в верхнем квантиле", matches: (r, q) => { const value = ratio(r.lower_shadow, r.candle_range ?? 0); return value !== undefined && value >= q.lowerShadowPct.high; } },
    { key: "green_series", label: "Серия зелёных свечей", matches: (r) => (r.green_streak ?? 0) >= 3 },
    { key: "red_series", label: "Серия красных свечей", matches: (r) => (r.red_streak ?? 0) >= 3 },
    { key: "volatility_high", label: "Волатильность в верхнем квантиле", matches: (r, q) => r.historical_volatility !== null && r.historical_volatility >= q.volatility.high },
    { key: "volatility_low", label: "Волатильность в нижнем квантиле", matches: (r, q) => r.historical_volatility !== null && r.historical_volatility <= q.volatility.low },
  ];
  const patternFactors: Factor[] = PROFESSIONAL_PATTERN_FACTORS.map(([name, direction]) => ({
    key: `pattern:${name}:${direction}`,
    label: `${name} (${direction})`,
    matches: (row: LocalRow) => row.patternKeys.includes(`${name}:${direction}`),
  }));
  return [...baseFactors, ...patternFactors];
}

function localRows(rows: ResearchRow[]) {
  return rows.map((row) => ({
    ...row,
    timestampMs: new Date(row.timestamp).getTime(),
  }));
}

function combinations(active: number[], maxSize = 2) {
  const result: number[][] = [];
  for (let left = 0; left < active.length; left += 1) {
    result.push([active[left]]);
    if (maxSize < 2) continue;
    for (let right = left + 1; right < active.length; right += 1) {
      result.push([active[left], active[right]]);
      if (maxSize >= 3) {
        for (let third = right + 1; third < active.length; third += 1) {
          result.push([active[left], active[right], active[third]]);
        }
      }
    }
  }
  return result;
}

function statKey(combo: number[], direction: Direction, holdingMinutes: number) {
  return `${combo.join(".")}|${direction}|${holdingMinutes}`;
}

function ensureStat(stats: Map<string, Stat>, combo: number[], direction: Direction, holdingMinutes: number) {
  const key = statKey(combo, direction, holdingMinutes);
  const existing = stats.get(key);
  if (existing) return existing;
  const created: Stat = {
    combo,
    direction,
    holdingMinutes,
    occurrences: 0,
    trainOccurrences: 0,
    testOccurrences: 0,
    wins: 0,
    trainWins: 0,
    testWins: 0,
    sum: 0,
    trainSum: 0,
    testSum: 0,
    positiveSum: 0,
    negativeSum: 0,
    trainPositiveSum: 0,
    trainNegativeSum: 0,
    testPositiveSum: 0,
    testNegativeSum: 0,
    sumSquares: 0,
    maxDrawdown: 0,
    equityByTicker: new Map(),
    periodStartMs: Number.POSITIVE_INFINITY,
    periodEndMs: 0,
  };
  stats.set(key, created);
  return created;
}

function updateStat(
  stat: Stat,
  ticker: string,
  timestampMs: number,
  value: number,
  inTrain: boolean,
) {
  stat.occurrences += 1;
  stat.periodStartMs = Math.min(stat.periodStartMs, timestampMs);
  stat.periodEndMs = Math.max(stat.periodEndMs, timestampMs);
  stat.wins += value > 0 ? 1 : 0;
  stat.sum += value;
  stat.sumSquares += value * value;
  if (value > 0) stat.positiveSum += value;
  else stat.negativeSum += value;
  if (inTrain) {
    stat.trainOccurrences += 1;
    stat.trainWins += value > 0 ? 1 : 0;
    stat.trainSum += value;
    if (value > 0) stat.trainPositiveSum += value;
    else stat.trainNegativeSum += value;
  } else {
    stat.testOccurrences += 1;
    stat.testWins += value > 0 ? 1 : 0;
    stat.testSum += value;
    if (value > 0) stat.testPositiveSum += value;
    else stat.testNegativeSum += value;
  }
  const equity = stat.equityByTicker.get(ticker) ?? { equity: 0, peak: 0, drawdown: 0 };
  equity.equity += value;
  equity.peak = Math.max(equity.peak, equity.equity);
  equity.drawdown = Math.max(equity.drawdown, equity.peak - equity.equity);
  stat.maxDrawdown = Math.max(stat.maxDrawdown, equity.drawdown);
  stat.equityByTicker.set(ticker, equity);
}

function profitFactor(positive: number, negative: number) {
  return negative === 0 ? null : positive / Math.abs(negative);
}

function conditionText(combo: number[], factors: Factor[]) {
  return combo.map((index) => factors[index].label).join(" + ");
}

function conditionKey(combo: number[], factors: Factor[]) {
  return combo.map((index) => factors[index].key).join("+");
}

function toMetrics(stat: Stat, factors: Factor[]): Metrics {
  const winRate = stat.wins / stat.occurrences;
  const [confidenceLow, confidenceHigh] = confidenceInterval(stat.wins, stat.occurrences);
  return {
    stat,
    conditionKey: conditionKey(stat.combo, factors),
    conditionLabel: conditionText(stat.combo, factors),
    winRate,
    averageProfit: stat.wins ? stat.positiveSum / stat.wins : 0,
    averageLoss: stat.occurrences - stat.wins ? stat.negativeSum / (stat.occurrences - stat.wins) : 0,
    expectedValue: stat.sum / stat.occurrences,
    profitFactor: profitFactor(stat.positiveSum, stat.negativeSum),
    pValue: twoSidedBinomialPValue(stat.wins, stat.occurrences),
    confidenceLow,
    confidenceHigh,
    trainWinRate: stat.trainOccurrences ? stat.trainWins / stat.trainOccurrences : 0,
    testWinRate: stat.testOccurrences ? stat.testWins / stat.testOccurrences : 0,
    trainExpectedValue: stat.trainOccurrences ? stat.trainSum / stat.trainOccurrences : 0,
    testExpectedValue: stat.testOccurrences ? stat.testSum / stat.testOccurrences : 0,
    testProfitFactor: profitFactor(stat.testPositiveSum, stat.testNegativeSum),
    qValue: 1,
    bestTakeProfit: 0,
    bestStopLoss: 0,
    periodStart: new Date(stat.periodStartMs),
    periodEnd: new Date(stat.periodEndMs),
  };
}

async function tickerRows(ticker: string) {
  const result = await db.execute(sql`
    SELECT c.ticker, c.timestamp, c.open, c.high, c.low, c.close, c.volume,
      f.rsi, f.ema_20, f.ema_50, f.ema_100, f.ema_200, f.macd_hist, f.adx,
      f.atr, f.vwap, f.bb_upper, f.bb_middle, f.bb_lower, f.bb_width,
      f.relative_volume, f.avg_volume_20, f.acceleration, f.price_change_3, f.price_change_5,
      f.body_size, f.body_to_range, f.upper_shadow, f.lower_shadow,
      f.green_streak, f.red_streak, f.candle_range, f.historical_volatility,
      COALESCE((
        SELECT array_agg(dp.pattern_type || ':' || dp.direction)
        FROM detected_patterns dp
        WHERE dp.ticker = c.ticker
          AND dp.timeframe = ${TIMEFRAME}
          AND dp.end_timestamp = c.timestamp
      ), ARRAY[]::text[]) AS "patternKeys"
    FROM candles c
    INNER JOIN features f ON f.ticker = c.ticker AND f.timestamp = c.timestamp
    WHERE c.ticker = ${ticker} AND c.timeframe = ${TIMEFRAME}
    ORDER BY c.timestamp ASC
  `);
  return localRows(result.rows as unknown as ResearchRow[]);
}

function outcome(rows: LocalRow[], index: number, bars: number, direction: Direction) {
  const future = rows[index + bars];
  if (!future || rows[index].close === 0) return undefined;
  return direction === "BUY"
    ? ((future.close - rows[index].close) / rows[index].close) * 100
    : ((rows[index].close - future.close) / rows[index].close) * 100;
}

function addBenjaminiHochberg(metrics: Metrics[]) {
  const sorted = [...metrics].sort((left, right) => left.pValue - right.pValue);
  let previous = 1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const rank = index + 1;
    const qValue = Math.min(previous, (sorted[index].pValue * sorted.length) / rank);
    sorted[index].qValue = qValue;
    previous = qValue;
  }
}

function createExitStats() {
  return Object.fromEntries(
    TAKE_PROFITS.flatMap((takeProfit) =>
      STOP_LOSSES.map((stopLoss) => [
        `${takeProfit}:${stopLoss}`,
        {
          count: 0,
          trainCount: 0,
          testCount: 0,
          wins: 0,
          trainWins: 0,
          testWins: 0,
          sum: 0,
          trainSum: 0,
          testSum: 0,
        } satisfies ExitStats,
      ]),
    ),
  ) as Record<string, ExitStats>;
}

function exitReturn(
  rows: LocalRow[],
  index: number,
  bars: number,
  direction: Direction,
  takeProfit: number,
  stopLoss: number,
) {
  const entry = rows[index].close;
  const takePrice = direction === "BUY" ? entry * (1 + takeProfit / 100) : entry * (1 - takeProfit / 100);
  const stopPrice = direction === "BUY" ? entry * (1 - stopLoss / 100) : entry * (1 + stopLoss / 100);
  const last = Math.min(rows.length - 1, index + bars);
  for (let cursor = index + 1; cursor <= last; cursor += 1) {
    const row = rows[cursor];
    const takeHit = direction === "BUY" ? row.high >= takePrice : row.low <= takePrice;
    const stopHit = direction === "BUY" ? row.low <= stopPrice : row.high >= stopPrice;
    if (stopHit) return -stopLoss;
    if (takeHit) return takeProfit;
  }
  return outcome(rows, index, bars, direction) ?? 0;
}

async function optimizeExits(
  candidates: Metrics[],
  tickerNames: string[],
  factors: Factor[],
  maxCandidates: number,
  maxEventsPerTicker: number,
) {
  const target = candidates.slice(0, maxCandidates);
  const exits = new Map<string, Record<string, ExitStats>>();
  for (const candidate of target) exits.set(statKey(candidate.stat.combo, candidate.stat.direction, candidate.stat.holdingMinutes), createExitStats());

  for (const ticker of tickerNames) {
    const rows = await tickerRows(ticker);
    if (rows.length < 100) continue;
    const split = Math.floor(rows.length * 0.7);
    const quantiles = buildQuantiles(rows);
    const stride = Math.max(1, Math.ceil(rows.length / maxEventsPerTicker));
    for (let index = 0; index < rows.length; index += stride) {
      const active = factors
        .map((factor, factorIndex) => (factor.matches(rows[index], quantiles) ? factorIndex : -1))
        .filter((factorIndex) => factorIndex >= 0);
      const activeSet = new Set(active);
      for (const candidate of target) {
        if (!candidate.stat.combo.every((factorIndex) => activeSet.has(factorIndex))) continue;
        const key = statKey(candidate.stat.combo, candidate.stat.direction, candidate.stat.holdingMinutes);
        const stats = exits.get(key);
        if (!stats) continue;
        for (const takeProfit of TAKE_PROFITS) {
          for (const stopLoss of STOP_LOSSES) {
            const exit = stats[`${takeProfit}:${stopLoss}`];
            const value = exitReturn(rows, index, Math.round(candidate.stat.holdingMinutes / 10), candidate.stat.direction, takeProfit, stopLoss);
            if (value === undefined) continue;
            const inTrain = index < split;
            exit.count += 1;
            exit.wins += value > 0 ? 1 : 0;
            exit.sum += value;
            if (inTrain) {
              exit.trainCount += 1;
              exit.trainWins += value > 0 ? 1 : 0;
              exit.trainSum += value;
            } else {
              exit.testCount += 1;
              exit.testWins += value > 0 ? 1 : 0;
              exit.testSum += value;
            }
          }
        }
      }
    }
  }

  for (const candidate of target) {
    const stats = exits.get(statKey(candidate.stat.combo, candidate.stat.direction, candidate.stat.holdingMinutes));
    if (!stats) continue;
    const best = Object.entries(stats)
      .filter(([, value]) => value.trainCount >= MIN_SPLIT_OCCURRENCES)
      .sort(([, left], [, right]) => (right.trainSum / right.trainCount) - (left.trainSum / left.trainCount))[0];
    if (best) {
      const [takeProfit, stopLoss] = best[0].split(":").map(Number);
      candidate.bestTakeProfit = takeProfit;
      candidate.bestStopLoss = stopLoss;
    }
  }
}

async function saveMetric(metric: Metrics, factors: Factor[]) {
  const conditions = metric.stat.combo.map((index) => ({
    key: factors[index].key,
    label: factors[index].label,
  }));
  const name = `auto-engine:${metric.conditionKey}:${metric.stat.direction}:${metric.stat.holdingMinutes}m:tp${metric.bestTakeProfit}:sl${metric.bestStopLoss}`;
  const values = {
    name,
    conditions,
    occurrences: metric.stat.occurrences,
    successRate: metric.winRate,
    averageProfit: metric.averageProfit,
    averageLoss: metric.averageLoss,
    expectedValue: metric.expectedValue,
    profitFactor: metric.profitFactor,
    pValue: metric.pValue,
    confidenceLow: metric.confidenceLow,
    confidenceHigh: metric.confidenceHigh,
    maxDrawdown: metric.stat.maxDrawdown,
    holdingMinutes: metric.stat.holdingMinutes,
    direction: metric.stat.direction,
    bestTakeProfit: metric.bestTakeProfit,
    bestStopLoss: metric.bestStopLoss,
    bestHoldingMinutes: metric.stat.holdingMinutes,
    trainWinRate: metric.trainWinRate,
    testWinRate: metric.testWinRate,
    trainExpectedValue: metric.trainExpectedValue,
    testExpectedValue: metric.testExpectedValue,
    testProfitFactor: metric.testProfitFactor,
    statisticalSignificance: true,
    isActive: true,
    discoveredAt: new Date(),
  };
  const combination = await db
    .insert(featureCombinations)
    .values(values)
    .onConflictDoUpdate({
      target: featureCombinations.name,
      set: values,
    })
    .returning({ id: featureCombinations.id });
  const combinationId = combination[0]?.id;
  if (!combinationId) return;
  const strategyValues = {
    name,
    version: "engine-1",
    conditions,
    winRate: metric.winRate,
    profitFactor: metric.profitFactor,
    expectedValue: metric.expectedValue,
    pValue: metric.pValue,
    confidenceLow: metric.confidenceLow,
    confidenceHigh: metric.confidenceHigh,
    maxDrawdown: metric.stat.maxDrawdown,
    averageProfit: metric.averageProfit,
    averageLoss: metric.averageLoss,
    bestTimeframe: TIMEFRAME,
    bestTakeProfit: metric.bestTakeProfit,
    bestStopLoss: metric.bestStopLoss,
    bestHoldingMinutes: metric.stat.holdingMinutes,
    trainWinRate: metric.trainWinRate,
    testWinRate: metric.testWinRate,
    trainExpectedValue: metric.trainExpectedValue,
    testExpectedValue: metric.testExpectedValue,
    testProfitFactor: metric.testProfitFactor,
    statisticalSignificance: true,
    tradesCount: metric.stat.occurrences,
    evaluatedAt: new Date(),
    metadata: {
      combinationId,
      direction: metric.stat.direction,
      qValue: metric.qValue,
      factorCount: metric.stat.combo.length,
    },
  };
  const strategy = await db
    .insert(strategyResults)
    .values(strategyValues)
    .onConflictDoUpdate({
      target: [strategyResults.name, strategyResults.version],
      set: strategyValues,
    })
    .returning({ id: strategyResults.id });
  if (!strategy[0]?.id) return;
  await db.insert(backtestResults).values({
    strategyId: strategy[0].id,
    ticker: null,
    timeframe: TIMEFRAME,
    periodStart: metric.periodStart,
    periodEnd: metric.periodEnd,
    tradesCount: metric.stat.occurrences,
    winRate: metric.winRate,
    profitFactor: metric.profitFactor,
    expectedValue: metric.expectedValue,
    maxDrawdown: metric.stat.maxDrawdown,
    averageProfit: metric.averageProfit,
    averageLoss: metric.averageLoss,
    netReturn: metric.expectedValue * metric.stat.occurrences,
    metadata: {
      conditionKey: metric.conditionKey,
      direction: metric.stat.direction,
      qValue: metric.qValue,
      bestTakeProfit: metric.bestTakeProfit,
      bestStopLoss: metric.bestStopLoss,
    },
  });
}

async function main() {
  const maxSavedResults = integerArg("max-results", MAX_SAVED_RESULTS);
  const maxCombinationSize = Math.min(3, integerArg("max-combination-size", 2));
  const maxEventsPerTicker = integerArg("max-events-per-ticker", 2500);
  const maxActiveFactors = integerArg("max-active-factors", 8);
  const maxTickers = integerArg("max-tickers", 100);
  const tickerRowsResult = await db
    .select({ ticker: moexTickers.secid })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(asc(moexTickers.rank))
    .limit(maxTickers);
  const tickerNames = tickerRowsResult.map((row) => row.ticker);
  const factors = buildFactors();
  const stats = new Map<string, Stat>();
  let totalEvents = 0;
  let combinationsSeen = 0;

  await db
    .update(featureCombinations)
    .set({ isActive: false })
    .where(sql`${featureCombinations.name} LIKE 'auto-engine:%'`);
  await db
    .update(strategyResults)
    .set({ statisticalSignificance: false })
    .where(sql`${strategyResults.name} LIKE 'auto-engine:%'`);

  console.log(
    `Исследовательское ядро: ${tickerNames.length} тикеров, ${factors.length} факторов, ` +
      `комбинации до ${maxCombinationSize} факторов, до ${maxEventsPerTicker} событий на тикер`,
  );
  for (const ticker of tickerNames) {
    const rows = await tickerRows(ticker);
    if (rows.length < 200) continue;
    const quantiles = buildQuantiles(rows);
    const split = Math.floor(rows.length * 0.7);
    const stride = Math.max(1, Math.ceil(rows.length / maxEventsPerTicker));
    for (let index = 0; index < rows.length; index += stride) {
      const active = factors
        .map((factor, factorIndex) => (factor.matches(rows[index], quantiles) ? factorIndex : -1))
        .filter((factorIndex) => factorIndex >= 0);
      const patternStart = factors.length - PROFESSIONAL_PATTERN_FACTORS.length;
      const patternActive = active.filter((factorIndex) => factorIndex >= patternStart).slice(0, 2);
      const baseActive = active
        .filter((factorIndex) => factorIndex < patternStart)
        .slice(0, Math.max(0, maxActiveFactors - patternActive.length));
      const rowCombinations = combinations([...baseActive, ...patternActive], maxCombinationSize);
      combinationsSeen += rowCombinations.length;
      totalEvents += 1;
      for (const combo of rowCombinations) {
        for (const direction of ["BUY", "SELL"] as const) {
          for (const holdingMinutes of HOLDING_MINUTES) {
            const value = outcome(rows, index, Math.round(holdingMinutes / 10), direction);
            if (value !== undefined) {
              updateStat(
                ensureStat(stats, combo, direction, holdingMinutes),
                ticker,
                rows[index].timestampMs,
                value,
                index < split,
              );
            }
          }
        }
      }
    }
    console.log(`${ticker}: ${rows.length} свечей, ${Math.ceil(rows.length / stride)} событий исследовано`);
  }

  const metrics = [...stats.values()]
    .filter((stat) => stat.occurrences >= MIN_OCCURRENCES && stat.trainOccurrences >= MIN_SPLIT_OCCURRENCES && stat.testOccurrences >= MIN_SPLIT_OCCURRENCES)
    .map((stat) => toMetrics(stat, factors))
    .filter((metric) => metric.trainExpectedValue > 0 && metric.testExpectedValue > 0);
  addBenjaminiHochberg(metrics);
  const significant = metrics
    .filter((metric) => metric.qValue <= 0.05 && metric.pValue <= 0.01 && metric.testWinRate > 0.5)
    .sort((left, right) => (right.testExpectedValue * Math.log1p(right.stat.occurrences)) - (left.testExpectedValue * Math.log1p(left.stat.occurrences)))
    .slice(0, maxSavedResults);

  const optimized = significant.slice(0, Math.min(significant.length, maxSavedResults));
  await optimizeExits(
    optimized,
    tickerNames,
    factors,
    optimized.length,
    Math.min(maxEventsPerTicker, 500),
  );
  for (const metric of optimized) await saveMetric(metric, factors);
  await pool.end();
  console.log(`Готово. Событий: ${totalEvents}; проверено комбинационных совпадений: ${combinationsSeen}; кандидатов: ${stats.size}; статистически значимых сохранено: ${optimized.length}`);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});