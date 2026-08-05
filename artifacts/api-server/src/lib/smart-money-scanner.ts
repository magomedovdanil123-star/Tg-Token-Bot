import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, moexTickers } from "@workspace/db";

type Direction = "BUY" | "SELL";
type Strength = "Weak" | "Medium" | "Strong" | "Extreme";
type Candle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Structure = {
  direction: Direction | null;
  bos: "Bullish" | "Bearish" | null;
  choch: "Bullish" | "Bearish" | null;
  swingHigh: number | null;
  swingLow: number | null;
};

type Accumulation = {
  strength: Strength;
  score: number;
  rangeHigh: number;
  rangeLow: number;
  rangePercent: number;
  atrCompression: number;
  insideCandles: number;
  levelTests: number;
  volumeRatio: number;
};

type MarketRegime = "BUY" | "SELL" | "NEUTRAL";
const ROUND_TRIP_COST_PERCENT = 0.2;
export const COMMODITY_TICKERS = ["XAUUSD", "XAGUSD", "BRENT"] as const;
export type SmartMoneyUniverse = "imoex" | "commodities";
export type SmartMoneySource = "smartmoney" | "commodity-smartmoney";
type SmartMoneyFilterStats = Record<
  | "cooldown"
  | "insufficientHistory"
  | "noAccumulation"
  | "noStructure"
  | "noBreakout"
  | "noVolume"
  | "noChoch"
  | "noHTFAlignment"
  | "opposedMarket"
  | "weakImpulse"
  | "oversizedCandle"
  | "lowNetRewardRisk"
  | "belowThreshold",
  number
>;

export type SmartMoneyCandidate = {
  ticker: string;
  direction: Direction;
  score: number;
  threshold: number;
  probability: number;
  timeframe: string;
  entryPrice: number;
  stopPrice: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  rewardRisk: number;
  netRewardRisk: number;
  accumulation: Accumulation;
  structure: Structure;
  liquidity: string[];
  orderBlock: string | null;
  fairValueGap: string | null;
  volumeConfirmed: boolean;
  retestConfirmed: boolean;
  higherTimeframeAgreement: string[];
  marketRegime: MarketRegime;
  bosQuality: number;
  impulseConfirmed: boolean;
  rangeToAtr: number;
  reasons: string[];
  chart: string;
  timestamp: Date;
};

export type SmartMoneyScan = {
  generatedAt: Date;
  analyzed: number;
  candidates: SmartMoneyCandidate[];
  unavailable: string[];
  threshold: number;
  cooldownSkipped: number;
  filterStats: SmartMoneyFilterStats;
  diagnostics: SmartMoneyTickerDiagnostic[];
};

export type SmartMoneyTickerDiagnostic = {
  ticker: string;
  passed: boolean;
  direction: Direction | null;
  score: number | null;
  threshold: number;
  reasons: string[];
};

export type SmartMoneyScanOptions = {
  universe?: SmartMoneyUniverse;
  source?: SmartMoneySource;
  skipCooldown?: boolean;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function percentile(values: number[], fraction: number) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function atr(rows: Candle[], period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.slice(1).map((row, index) => {
    const previous = rows[index];
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previous.close),
      Math.abs(row.low - previous.close),
    );
  });
  return average(ranges.slice(-period));
}

function percent(from: number, to: number) {
  return from === 0 ? 0 : ((to - from) / from) * 100;
}

function round(value: number) {
  return Number(value.toFixed(6));
}

function bucketTimestamp(timestamp: Date, minutes: number) {
  const milliseconds = minutes * 60_000;
  return new Date(Math.floor(timestamp.getTime() / milliseconds) * milliseconds);
}

function aggregate(rows: Candle[], minutes: number) {
  const groups = new Map<number, Candle[]>();
  for (const row of rows) {
    const bucket = bucketTimestamp(row.timestamp, minutes).getTime();
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => ({
      timestamp: group.at(-1)!.timestamp,
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, row) => sum + row.volume, 0),
    }));
}

function aggregateClosed(rows: Candle[], minutes: number) {
  if (!rows.length) return [];
  const latestBucket = bucketTimestamp(rows.at(-1)!.timestamp, minutes).getTime();
  return aggregate(
    rows.filter(
      (row) => bucketTimestamp(row.timestamp, minutes).getTime() < latestBucket,
    ),
    minutes,
  );
}

function swings(rows: Candle[], lookback = 2) {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  for (let index = lookback; index < rows.length - lookback; index += 1) {
    const row = rows[index];
    const before = rows.slice(index - lookback, index);
    const after = rows.slice(index + 1, index + lookback + 1);
    if (
      before.every((item) => item.high <= row.high) &&
      after.every((item) => item.high <= row.high)
    ) {
      highs.push({ index, price: row.high });
    }
    if (
      before.every((item) => item.low >= row.low) &&
      after.every((item) => item.low >= row.low)
    ) {
      lows.push({ index, price: row.low });
    }
  }
  return { highs, lows };
}

function structure(rows: Candle[]): Structure {
  const pivots = swings(rows);
  const recentHigh = pivots.highs.at(-1);
  const priorHigh = pivots.highs.at(-2);
  const recentLow = pivots.lows.at(-1);
  const priorLow = pivots.lows.at(-2);
  const latest = rows.at(-1);
  if (!latest || !recentHigh || !recentLow) {
    return { direction: null, bos: null, choch: null, swingHigh: null, swingLow: null };
  }

  const priorDirection =
    priorHigh && priorLow && recentHigh.price > priorHigh.price && recentLow.price > priorLow.price
      ? "BUY"
      : priorHigh && priorLow && recentHigh.price < priorHigh.price && recentLow.price < priorLow.price
        ? "SELL"
        : null;
  const bos = latest.close > recentHigh.price
    ? "Bullish"
    : latest.close < recentLow.price
      ? "Bearish"
      : null;
  const direction = bos === "Bullish" ? "BUY" : bos === "Bearish" ? "SELL" : priorDirection;
  const choch =
    bos === "Bullish" && priorDirection === "SELL"
      ? "Bullish"
      : bos === "Bearish" && priorDirection === "BUY"
        ? "Bearish"
        : null;

  return {
    direction,
    bos,
    choch,
    swingHigh: recentHigh.price,
    swingLow: recentLow.price,
  };
}

function accumulation(rows: Candle[]): Accumulation | null {
  if (rows.length < 60) return null;
  const recent = rows.slice(-24);
  const previous = rows.slice(-48, -24);
  const recentHigh = Math.max(...recent.map((row) => row.high));
  const recentLow = Math.min(...recent.map((row) => row.low));
  const previousHigh = Math.max(...previous.map((row) => row.high));
  const previousLow = Math.min(...previous.map((row) => row.low));
  const rangePercent = Math.abs(percent(recentLow, recentHigh));
  const previousRangePercent = Math.abs(percent(previousLow, previousHigh));
  const recentAtr = atr(recent);
  const previousAtr = atr(previous);
  const atrCompression = recentAtr && previousAtr ? recentAtr / previousAtr : 1;
  const rangeWidth = recentHigh - recentLow || 1;
  const insideCandles = recent.filter(
    (row) => row.high <= previousHigh && row.low >= previousLow,
  ).length;
  const levelTests = recent.filter(
    (row) =>
      Math.abs(row.high - recentHigh) / recentHigh < 0.002 ||
      Math.abs(row.low - recentLow) / recentLow < 0.002,
  ).length;
  const recentVolume = average(recent.slice(-8).map((row) => row.volume)) ?? 0;
  const baselineVolume = average(previous.slice(-16).map((row) => row.volume)) ?? 0;
  const volumeRatio = baselineVolume > 0 ? recentVolume / baselineVolume : 1;

  let points = 0;
  if (atrCompression <= 0.75) points += 2;
  else if (atrCompression <= 0.9) points += 1;
  if (rangePercent <= Math.max(0.8, previousRangePercent * 0.7)) points += 2;
  else if (rangePercent <= Math.max(1.2, previousRangePercent * 0.9)) points += 1;
  if (insideCandles >= 12) points += 2;
  else if (insideCandles >= 7) points += 1;
  if (levelTests >= 4) points += 2;
  else if (levelTests >= 2) points += 1;
  if (volumeRatio >= 1.15) points += 2;
  else if (volumeRatio >= 0.95) points += 1;
  if (recentHigh - recentLow <= rows.at(-1)!.close * 0.03) points += 1;

  const strength: Strength =
    points >= 9 ? "Extreme" : points >= 7 ? "Strong" : points >= 5 ? "Medium" : "Weak";
  const score = strength === "Extreme" ? 35 : strength === "Strong" ? 25 : strength === "Medium" ? 15 : 0;
  return {
    strength,
    score,
    rangeHigh: recentHigh,
    rangeLow: recentLow,
    rangePercent,
    atrCompression,
    insideCandles,
    levelTests,
    volumeRatio,
  };
}

function liquiditySignals(rows: Candle[], current: Candle, levels: Structure) {
  const signals: string[] = [];
  const tolerance = current.close * 0.0015;
  const equalHigh = levels.swingHigh !== null &&
    rows.slice(-24).filter((row) => Math.abs(row.high - levels.swingHigh!) <= tolerance).length >= 2;
  const equalLow = levels.swingLow !== null &&
    rows.slice(-24).filter((row) => Math.abs(row.low - levels.swingLow!) <= tolerance).length >= 2;
  if (equalHigh) signals.push("Equal High liquidity");
  if (equalLow) signals.push("Equal Low liquidity");
  if (
    levels.swingHigh !== null &&
    current.high > levels.swingHigh &&
    current.close < levels.swingHigh
  ) {
    signals.push("Bearish Liquidity Grab / Stop Hunt");
  }
  if (
    levels.swingLow !== null &&
    current.low < levels.swingLow &&
    current.close > levels.swingLow
  ) {
    signals.push("Bullish Liquidity Grab / Stop Hunt");
  }
  return signals;
}

function orderBlock(rows: Candle[], direction: Direction, levels: Structure) {
  const start = Math.max(0, rows.length - 15);
  for (let index = rows.length - 2; index >= start; index -= 1) {
    const row = rows[index];
    const bullish = row.close > row.open;
    if (direction === "BUY" && !bullish && levels.swingHigh !== null && rows.at(-1)!.close > levels.swingHigh) {
      return `Bullish Order Block ${round(row.low)}–${round(row.high)}`;
    }
    if (direction === "SELL" && bullish && levels.swingLow !== null && rows.at(-1)!.close < levels.swingLow) {
      return `Bearish Order Block ${round(row.low)}–${round(row.high)}`;
    }
  }
  return null;
}

function fairValueGap(rows: Candle[], direction: Direction) {
  for (let index = rows.length - 1; index >= Math.max(2, rows.length - 12); index -= 1) {
    const left = rows[index - 2];
    const right = rows[index];
    if (direction === "BUY" && right.low > left.high) {
      const filled = rows.slice(index + 1).some((row) => row.low <= left.high);
      return filled ? null : `Bullish FVG ${round(left.high)}–${round(right.low)}`;
    }
    if (direction === "SELL" && right.high < left.low) {
      const filled = rows.slice(index + 1).some((row) => row.high >= left.low);
      return filled ? null : `Bearish FVG ${round(right.high)}–${round(left.low)}`;
    }
  }
  return null;
}

function chart(rows: Candle[], candidate: {
  entry: number;
  stop: number;
  target: number;
  rangeLow: number;
  rangeHigh: number;
}) {
  const points = rows.slice(-32).map((row) => row.close);
  const min = Math.min(candidate.stop, candidate.rangeLow, ...points);
  const max = Math.max(candidate.target, candidate.rangeHigh, ...points);
  const height = 8;
  const width = 32;
  const lines = Array.from({ length: height }, (_, row) => {
    const level = max - ((max - min) * row) / (height - 1 || 1);
    const path = points.map((point) => {
      const position = Math.round(((point - min) / (max - min || 1)) * (width - 1));
      return position === Math.round((points.indexOf(point) / Math.max(1, points.length - 1)) * (width - 1))
        ? "●"
        : " ";
    }).join("");
    const label = Math.abs(level - candidate.entry) / Math.max(1, max) < 0.001 ? " ENTRY" : "";
    return `${String(level.toFixed(2)).padStart(10)} │${path}${label}`;
  });
  return lines.join("\n");
}

function higherTimeframeDirection(rows: Candle[]): Direction | null {
  if (rows.length < 20) return null;
  const recent = rows.slice(-10);
  const older = rows.slice(-20, -10);
  const recentClose = recent.at(-1)!.close;
  const recentAverage = average(recent.map((row) => row.close)) ?? recentClose;
  const olderAverage = average(older.map((row) => row.close)) ?? recentClose;
  return recentAverage > olderAverage && recentClose > recent[0].close
    ? "BUY"
    : recentAverage < olderAverage && recentClose < recent[0].close
      ? "SELL"
      : null;
}

function getMarketRegime(rows: Candle[]): MarketRegime {
  if (rows.length < 20) return "NEUTRAL";
  const direction = higherTimeframeDirection(rows);
  if (!direction) return "NEUTRAL";
  const recentClose = rows.at(-1)!.close;
  const referenceClose = rows.at(-6)!.close;
  const change = Math.abs(percent(referenceClose, recentClose));
  return change >= 0.35 ? direction : "NEUTRAL";
}

function breakoutQuality(
  current: Candle,
  levels: Structure,
  direction: Direction,
  currentAtr: number,
) {
  const level = direction === "BUY" ? levels.swingHigh : levels.swingLow;
  if (!level || currentAtr <= 0) {
    return { quality: 0, impulseConfirmed: false };
  }
  const distanceAtr = Math.abs(current.close - level) / currentAtr;
  const candleRange = Math.max(current.high - current.low, currentAtr * 0.01);
  const bodyRatio = Math.abs(current.close - current.open) / candleRange;
  const closeLocation =
    direction === "BUY"
      ? (current.close - current.low) / candleRange
      : (current.high - current.close) / candleRange;
  const impulseConfirmed =
    distanceAtr >= 0.12 && bodyRatio >= 0.45 && closeLocation >= 0.62;
  return {
    quality: round(distanceAtr),
    impulseConfirmed,
  };
}

async function getAdaptiveThreshold(source: SmartMoneySource) {
  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE outcome IN ('TP', 'MANUAL_WIN', 'TIMEOUT_WIN')
      )::int AS wins
    FROM signals_history
      WHERE metadata ->> 'source' = ${source}
      AND outcome IS NOT NULL
      AND generated_at >= NOW() - INTERVAL '90 days'
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const total = Number(row.total) || 0;
  const wins = Number(row.wins) || 0;
  if (total < 20) return 80;
  const winRate = wins / total;
  if (winRate < 0.45) return 90;
  if (winRate > 0.65) return 78;
  return 82;
}

function rowsFromResult(result: { rows: unknown[] }) {
  return result.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        ticker: String(row.ticker),
        timeframe: String(row.timeframe),
        timestamp: new Date(String(row.timestamp)),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume) || 0,
      };
    })
    .filter((row) => Number.isFinite(row.timestamp.getTime()) && finite(row.close));
}

export async function scanSmartMoney(
  requestedTicker?: string,
  options: SmartMoneyScanOptions = {},
): Promise<SmartMoneyScan> {
  const universe = options.universe ?? "imoex";
  const source = options.source ?? "smartmoney";
  const generatedAt = new Date();
  const adaptiveThreshold = await getAdaptiveThreshold(source);
  const tickerRows = await db
    .select({ ticker: moexTickers.secid })
    .from(moexTickers)
    .where(
      universe === "commodities"
        ? requestedTicker
          ? inArray(moexTickers.secid, [requestedTicker])
          : inArray(moexTickers.secid, [...COMMODITY_TICKERS])
        : requestedTicker
          ? or(eq(moexTickers.isActive, true), eq(moexTickers.secid, requestedTicker))
          : eq(moexTickers.isActive, true),
    )
    .orderBy(desc(moexTickers.rank));
  const activeTickers = tickerRows.map((row) => row.ticker).filter((ticker) => ticker !== "IMOEX");
  const tickers = universe === "commodities"
    ? activeTickers.filter((ticker) =>
        COMMODITY_TICKERS.includes(ticker as (typeof COMMODITY_TICKERS)[number]),
      )
    : requestedTicker
      ? activeTickers.filter((ticker) => ticker === requestedTicker)
      : activeTickers;
  const result = await db.execute(sql`
    SELECT ticker, timeframe, timestamp, open, high, low, close, volume
    FROM (
      SELECT ticker, timeframe, timestamp, open, high, low, close, volume,
        ROW_NUMBER() OVER (PARTITION BY ticker, timeframe ORDER BY timestamp DESC) AS row_number
      FROM candles
      WHERE timeframe IN ('1m', '1h')
    ) latest
    WHERE row_number <= 2880
    ORDER BY ticker, timeframe, timestamp
  `);
  const rows = rowsFromResult(result);
  const marketOneHour = rows
    .filter((row) => row.ticker === "IMOEX" && row.timeframe === "1h")
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const marketRegime = getMarketRegime(aggregateClosed(marketOneHour, 60));
  const cooldownResult = await db.execute(sql`
    SELECT DISTINCT ticker
    FROM signals_history
    WHERE metadata ->> 'source' = ${source}
      AND generated_at >= NOW() - INTERVAL '90 minutes'
  `);
  const cooldownTickers = new Set(
    cooldownResult.rows.map((row) => String((row as { ticker: string }).ticker)),
  );
  const byTicker = new Map<string, { oneMinute: Candle[]; oneHour: Candle[] }>();
  for (const ticker of tickers) {
    byTicker.set(ticker, {
      oneMinute: rows.filter((row) => row.ticker === ticker && row.timeframe === "1m"),
      oneHour: rows.filter((row) => row.ticker === ticker && row.timeframe === "1h"),
    });
  }

  const candidates: SmartMoneyCandidate[] = [];
  const unavailable: string[] = [];
  const diagnostics: SmartMoneyTickerDiagnostic[] = [];
  let cooldownSkipped = 0;
  const filterStats: SmartMoneyFilterStats = {
    cooldown: 0,
    insufficientHistory: 0,
    noAccumulation: 0,
    noStructure: 0,
    noBreakout: 0,
    noVolume: 0,
    noChoch: 0,
    noHTFAlignment: 0,
    opposedMarket: 0,
    weakImpulse: 0,
    oversizedCandle: 0,
    lowNetRewardRisk: 0,
    belowThreshold: 0,
  };
  for (const ticker of tickers) {
    if (!options.skipCooldown && cooldownTickers.has(ticker)) {
      cooldownSkipped += 1;
      filterStats.cooldown += 1;
      diagnostics.push({
        ticker,
        passed: false,
        direction: null,
        score: null,
        threshold: adaptiveThreshold,
        reasons: ["Тикер находится в 90-минутном cooldown после предыдущего SMC-сигнала."],
      });
      continue;
    }
    const series = byTicker.get(ticker)!;
    const primary = aggregateClosed(series.oneMinute, 15);
    const thirty = aggregateClosed(series.oneMinute, 30);
    const oneHour = aggregateClosed(series.oneHour, 60);
    const fourHour = aggregateClosed(oneHour, 240);
    const daily = aggregateClosed(oneHour, 1440);
    if (primary.length < 60 || oneHour.length < 20) {
      unavailable.push(`${ticker}: недостаточно 1m/1h свечей`);
      filterStats.insufficientHistory += 1;
      diagnostics.push({
        ticker,
        passed: false,
        direction: null,
        score: null,
        threshold: adaptiveThreshold,
        reasons: [
          `Недостаточно истории: 1m закрытых свечей ${primary.length}/60, 1H закрытых свечей ${oneHour.length}/20.`,
        ],
      });
      continue;
    }
    const current = primary.at(-1)!;
    const levels = structure(primary);
    const range = accumulation(primary);
    if (!range) {
      filterStats.noAccumulation += 1;
      diagnostics.push({
        ticker,
        passed: false,
        direction: null,
        score: null,
        threshold: adaptiveThreshold,
        reasons: ["Недостаточно данных для проверки накопления."],
      });
      continue;
    }
    if (!levels.direction) {
      filterStats.noStructure += 1;
      diagnostics.push({
        ticker,
        passed: false,
        direction: null,
        score: null,
        threshold: adaptiveThreshold,
        reasons: ["Не определено направленное движение структуры по последним подтверждённым swing high/low."],
      });
      continue;
    }

    const direction = levels.direction;
    const currentMarketRegime = universe === "commodities"
      ? getMarketRegime(oneHour)
      : marketRegime;
    const liquidity = liquiditySignals(primary, current, levels);
    const block = orderBlock(primary, direction, levels);
    const fvg = fairValueGap(primary, direction);
    const currentAtr = atr(primary) ?? current.close * 0.005;
    const breakout = levels.bos === (direction === "BUY" ? "Bullish" : "Bearish");
    const breakoutMetrics = breakoutQuality(current, levels, direction, currentAtr);
    const rangeToAtr =
      currentAtr > 0 ? (current.high - current.low) / currentAtr : Number.POSITIVE_INFINITY;
    const averageVolume = average(primary.slice(-21, -1).map((row) => row.volume)) ?? 0;
    const volumeRatio = averageVolume > 0 ? current.volume / averageVolume : 0;
    const momentum = Math.abs(percent(primary.at(-4)!.close, current.close));
    const volumeConfirmed = volumeRatio >= 1.2;
    const retestLevel = direction === "BUY" ? levels.swingHigh : levels.swingLow;
    const retestConfirmed =
      retestLevel !== null &&
      primary.slice(-5, -1).some((row) =>
        direction === "BUY"
          ? row.low <= retestLevel * 1.003 && row.close > retestLevel
          : row.high >= retestLevel * 0.997 && row.close < retestLevel,
      );
    const fourHourDirection = higherTimeframeDirection(fourHour);
    const dailyDirection = higherTimeframeDirection(daily);
    const agreement = [
      fourHourDirection === direction ? "4H" : null,
      dailyDirection === direction ? "1D" : null,
      higherTimeframeDirection(thirty) === direction ? "30M" : null,
      higherTimeframeDirection(oneHour) === direction ? "1H" : null,
    ].filter((value): value is string => Boolean(value));
    const trendAligned = agreement.length >= 2;
    const trendOpposed =
      [fourHourDirection, dailyDirection].some((value) => value !== null && value !== direction);

    let score = range.score;
    if (breakout) score += 20;
    if (levels.choch === (direction === "BUY" ? "Bullish" : "Bearish")) score += 15;
    if (liquidity.length) score += 15;
    if (block) score += 10;
    if (fvg) score += 5;
    if (volumeConfirmed) score += 15;
    if (retestConfirmed) score += 10;
    score += agreement.includes("4H") ? 10 : 0;
    score += agreement.includes("1D") ? 10 : 0;
    score += trendAligned ? 10 : 0;
    if (trendOpposed) score -= 10;
    score += breakoutMetrics.impulseConfirmed ? 8 : 0;
    score += currentMarketRegime === direction
      ? 8
      : currentMarketRegime === "NEUTRAL"
        ? 0
        : -12;
    if (rangeToAtr <= 2.5) score += 4;
    if (rangeToAtr > 3) score -= 8;

    const threshold = Math.max(
      adaptiveThreshold,
      trendOpposed && !trendAligned ? 90 : agreement.length >= 2 ? 80 : 85,
    );
    const stopPrice = direction === "BUY"
      ? Math.min(levels.swingLow ?? current.close - currentAtr, current.close - currentAtr * 0.8)
      : Math.max(levels.swingHigh ?? current.close + currentAtr, current.close + currentAtr * 0.8);
    const risk = Math.abs(current.close - stopPrice);
    const takeProfit1 = direction === "BUY" ? current.close + risk : current.close - risk;
    const takeProfit2 = direction === "BUY" ? current.close + risk * 2 : current.close - risk * 2;
    const takeProfit3 = direction === "BUY" ? current.close + risk * 3 : current.close - risk * 3;
    const rewardRisk = risk > 0 ? Math.abs(takeProfit2 - current.close) / risk : 0;
    const roundTripCost = current.close * (ROUND_TRIP_COST_PERCENT / 100);
    const netRewardRisk =
      risk + roundTripCost > 0
        ? (Math.abs(takeProfit2 - current.close) - roundTripCost) /
          (risk + roundTripCost)
        : 0;
    const rejected =
      range.strength === "Weak" ||
      !breakout ||
      !volumeConfirmed ||
      !levels.choch && !(breakoutMetrics.impulseConfirmed && trendAligned) ||
      !trendAligned ||
      (currentMarketRegime !== "NEUTRAL" && currentMarketRegime !== direction) ||
      !breakoutMetrics.impulseConfirmed ||
      rangeToAtr > 3.5 ||
      netRewardRisk < 1.65 ||
      score < threshold;
    if (rejected) {
      const diagnosticReasons = [
        range.strength === "Weak" ? `Накопление слабое: ${range.strength}.` : null,
        !breakout ? "Нет закрытого пробоя swing-уровня (BOS)." : null,
        !volumeConfirmed ? "Объём не подтверждает импульс (меньше 1.2x среднего)." : null,
        !levels.choch && !(breakoutMetrics.impulseConfirmed && trendAligned)
          ? "Нет CHoCH и нет альтернативного подтверждения: качественный BOS + HTF alignment."
          : null,
        !trendAligned ? "Недостаточно согласования старших таймфреймов: нужно минимум 2 направления." : null,
        currentMarketRegime !== "NEUTRAL" && currentMarketRegime !== direction
          ? `Конфликт с режимом рынка: ${currentMarketRegime}.`
          : null,
        !breakoutMetrics.impulseConfirmed ? "Импульс BOS слабый или закрытие недостаточно далеко за уровнем." : null,
        rangeToAtr > 3.5 ? `Сигнальная свеча слишком большая: ${rangeToAtr.toFixed(2)} ATR.` : null,
        netRewardRisk < 1.65 ? `Низкий net R:R после издержек: ${netRewardRisk.toFixed(2)}.` : null,
        score < threshold ? `Рейтинг ${Math.round(score)} ниже порога ${threshold}.` : null,
      ].filter((reason): reason is string => Boolean(reason));
      diagnostics.push({
        ticker,
        passed: false,
        direction,
        score: Math.round(score),
        threshold,
        reasons: diagnosticReasons,
      });
      if (range.strength === "Weak") filterStats.noAccumulation += 1;
      if (!breakout) filterStats.noBreakout += 1;
      if (!volumeConfirmed) filterStats.noVolume += 1;
      if (!levels.choch && !(breakoutMetrics.impulseConfirmed && trendAligned)) {
        filterStats.noChoch += 1;
      }
      if (!trendAligned) filterStats.noHTFAlignment += 1;
      if (currentMarketRegime !== "NEUTRAL" && currentMarketRegime !== direction) {
        filterStats.opposedMarket += 1;
      }
      if (!breakoutMetrics.impulseConfirmed) filterStats.weakImpulse += 1;
      if (rangeToAtr > 3.5) filterStats.oversizedCandle += 1;
      if (netRewardRisk < 1.65) filterStats.lowNetRewardRisk += 1;
      if (score < threshold) filterStats.belowThreshold += 1;
      continue;
    }

    const reasons = [
      `${range.strength} Accumulation · сжатие ATR ${Math.round(range.atrCompression * 100)}%`,
      `${levels.bos} BOS`,
      `${levels.choch} CHoCH`,
      liquidity.length ? liquidity.join(", ") : "Liquidity подтверждена структурой",
      block ?? "Order Block не найден",
      fvg ?? "FVG не найден",
      `Volume Confirmation ${volumeRatio.toFixed(2)}x`,
      `Net R:R ${netRewardRisk.toFixed(2)} после ${ROUND_TRIP_COST_PERCENT.toFixed(2)}% издержек`,
      `BOS impulse ${breakoutMetrics.quality.toFixed(2)} ATR · ${breakoutMetrics.impulseConfirmed ? "подтверждён" : "слабый"}`,
      `Свеча/ATR ${rangeToAtr.toFixed(2)}x`,
      retestConfirmed ? "Retest подтверждён" : "Retest не подтверждён",
      `HTF alignment: ${agreement.join(", ")}`,
      `Режим рынка: ${currentMarketRegime === "BUY" ? "сильный рынок" : currentMarketRegime === "SELL" ? "слабый рынок" : "нейтральный"}`,
    ];
    const chartText = chart(primary, {
      entry: current.close,
      stop: stopPrice,
      target: takeProfit3,
      rangeLow: range.rangeLow,
      rangeHigh: range.rangeHigh,
    });
    candidates.push({
      ticker,
      direction,
      score: Math.min(100, Math.round(score)),
      threshold,
      probability: Math.min(97, Math.max(80, Math.round(score * 0.94))),
      timeframe: "15m + 1H/4H/1D",
      entryPrice: current.close,
      stopPrice,
      takeProfit1,
      takeProfit2,
      takeProfit3,
      rewardRisk,
      netRewardRisk: round(netRewardRisk),
      accumulation: range,
      structure: levels,
      liquidity,
      orderBlock: block,
      fairValueGap: fvg,
      volumeConfirmed,
      retestConfirmed,
      higherTimeframeAgreement: agreement,
      marketRegime: currentMarketRegime,
      bosQuality: breakoutMetrics.quality,
      impulseConfirmed: breakoutMetrics.impulseConfirmed,
      rangeToAtr: round(rangeToAtr),
      reasons,
      chart: chartText,
      timestamp: current.timestamp,
    });
    diagnostics.push({
      ticker,
      passed: true,
      direction,
      score: Math.min(100, Math.round(score)),
      threshold,
      reasons: ["Все фильтры Smart Money пройдены; сетап допущен к paper-сигналу."],
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  return {
    generatedAt,
    analyzed: tickers.length,
    candidates: candidates.slice(0, 5),
    unavailable,
    threshold: adaptiveThreshold,
    cooldownSkipped,
    filterStats,
    diagnostics,
  };
}