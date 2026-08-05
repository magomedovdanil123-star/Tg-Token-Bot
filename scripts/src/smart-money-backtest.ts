import { asc, eq, sql } from "drizzle-orm";
import { db, moexTickers } from "@workspace/db";

type Direction = "BUY" | "SELL";
type Strength = "Weak" | "Medium" | "Strong" | "Extreme";
type Candle = {
  ticker: string;
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
type Candidate = {
  ticker: string;
  direction: Direction;
  score: number;
  threshold: number;
  entry: number;
  stop: number;
  target: number;
  timestamp: Date;
  netRewardRisk: number;
};
type EvaluatedTrade = Candidate & {
  outcome: "TP" | "SL" | "TIMEOUT_WIN" | "TIMEOUT_LOSS";
  outcomePercent: number;
  exitTimestamp: Date;
  allocation: number;
};

const COST_PERCENT = 0.2;
const PORTFOLIO = 100_000;
const MAX_POSITIONS = 5;
const ALLOCATION = PORTFOLIO / MAX_POSITIONS;
const HORIZON_MINUTES = 360;
const PRIMARY_LOOKBACK = 192;
const THIRTY_LOOKBACK = 96;
const HOURLY_LOOKBACK = 2880;

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percent(from: number, to: number) {
  return from === 0 ? 0 : ((to - from) / from) * 100;
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

function bucketTimestamp(timestamp: Date, minutes: number) {
  const size = minutes * 60_000;
  return new Date(Math.floor(timestamp.getTime() / size) * size);
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
      ...group.at(-1)!,
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

function upperBound(rows: Candle[], timestamp: number) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].timestamp.getTime() <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rowsThrough(rows: Candle[], timestamp: number, limit: number) {
  return rows.slice(Math.max(0, upperBound(rows, timestamp) - limit), upperBound(rows, timestamp));
}

function swings(rows: Candle[], lookback = 2) {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  for (let index = lookback; index < rows.length - lookback; index += 1) {
    const row = rows[index];
    const before = rows.slice(index - lookback, index);
    const after = rows.slice(index + 1, index + lookback + 1);
    if (before.every((item) => item.high <= row.high) && after.every((item) => item.high <= row.high)) {
      highs.push({ index, price: row.high });
    }
    if (before.every((item) => item.low >= row.low) && after.every((item) => item.low >= row.low)) {
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
  const bos =
    latest.close > recentHigh.price
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
  return {
    strength,
    score: strength === "Extreme" ? 35 : strength === "Strong" ? 25 : strength === "Medium" ? 15 : 0,
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
  const equalHigh =
    levels.swingHigh !== null &&
    rows.slice(-24).filter((row) => Math.abs(row.high - levels.swingHigh!) <= tolerance).length >= 2;
  const equalLow =
    levels.swingLow !== null &&
    rows.slice(-24).filter((row) => Math.abs(row.low - levels.swingLow!) <= tolerance).length >= 2;
  if (equalHigh) signals.push("Equal High liquidity");
  if (equalLow) signals.push("Equal Low liquidity");
  if (levels.swingHigh !== null && current.high > levels.swingHigh && current.close < levels.swingHigh) {
    signals.push("Bearish Liquidity Grab / Stop Hunt");
  }
  if (levels.swingLow !== null && current.low < levels.swingLow && current.close > levels.swingLow) {
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
      return true;
    }
    if (direction === "SELL" && bullish && levels.swingLow !== null && rows.at(-1)!.close < levels.swingLow) {
      return true;
    }
  }
  return false;
}

function fairValueGap(rows: Candle[], direction: Direction) {
  for (let index = rows.length - 1; index >= Math.max(2, rows.length - 12); index -= 1) {
    const left = rows[index - 2];
    const right = rows[index];
    if (direction === "BUY" && right.low > left.high) {
      const filled = rows.slice(index + 1).some((row) => row.low <= left.high);
      if (!filled) return true;
    }
    if (direction === "SELL" && right.high < left.low) {
      const filled = rows.slice(index + 1).some((row) => row.high >= left.low);
      if (!filled) return true;
    }
  }
  return false;
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

function getMarketRegime(rows: Candle[]) {
  if (rows.length < 20) return "NEUTRAL" as const;
  const direction = higherTimeframeDirection(rows);
  if (!direction) return "NEUTRAL" as const;
  const change = Math.abs(percent(rows.at(-6)!.close, rows.at(-1)!.close));
  return change >= 0.35 ? direction : "NEUTRAL" as const;
}

function breakoutQuality(current: Candle, levels: Structure, direction: Direction, currentAtr: number) {
  const level = direction === "BUY" ? levels.swingHigh : levels.swingLow;
  if (!level || currentAtr <= 0) return { quality: 0, impulseConfirmed: false };
  const distanceAtr = Math.abs(current.close - level) / currentAtr;
  const candleRange = Math.max(current.high - current.low, currentAtr * 0.01);
  const bodyRatio = Math.abs(current.close - current.open) / candleRange;
  const closeLocation =
    direction === "BUY"
      ? (current.close - current.low) / candleRange
      : (current.high - current.close) / candleRange;
  return {
    quality: distanceAtr,
    impulseConfirmed: distanceAtr >= 0.12 && bodyRatio >= 0.45 && closeLocation >= 0.62,
  };
}

function candidateAt(
  ticker: string,
  primarySource: Candle[],
  thirtySource: Candle[],
  oneHourRaw: Candle[],
  marketRaw: Candle[],
  threshold: number,
  asOf: Date,
): Candidate | null {
  const currentBucket = bucketTimestamp(asOf, 15).getTime();
  const primary = primarySource
    .filter(
      (row) => bucketTimestamp(row.timestamp, 15).getTime() < currentBucket,
    )
    .slice(-PRIMARY_LOOKBACK);
  const thirty = rowsThrough(
    thirtySource,
    currentBucket - 1,
    THIRTY_LOOKBACK,
  );
  const oneHourSource = rowsThrough(oneHourRaw, asOf.getTime(), HOURLY_LOOKBACK);
  const marketSource = rowsThrough(marketRaw, asOf.getTime(), HOURLY_LOOKBACK);
  const oneHour = aggregateClosed(oneHourSource, 60);
  const fourHour = aggregateClosed(oneHour, 240);
  const daily = aggregateClosed(oneHour, 1440);
  if (primary.length < 60 || oneHour.length < 20) return null;
  const current = primary.at(-1)!;
  const levels = structure(primary);
  const range = accumulation(primary);
  if (!range || !levels.direction) return null;
  const direction = levels.direction;
  const liquidity = liquiditySignals(primary, current, levels);
  const block = orderBlock(primary, direction, levels);
  const fvg = fairValueGap(primary, direction);
  const currentAtr = atr(primary) ?? current.close * 0.005;
  const breakout = levels.bos === (direction === "BUY" ? "Bullish" : "Bearish");
  const breakoutMetrics = breakoutQuality(current, levels, direction, currentAtr);
  const rangeToAtr = currentAtr > 0 ? (current.high - current.low) / currentAtr : Number.POSITIVE_INFINITY;
  const averageVolume = average(primary.slice(-21, -1).map((row) => row.volume)) ?? 0;
  const volumeRatio = averageVolume > 0 ? current.volume / averageVolume : 0;
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
  const trendOpposed = [fourHourDirection, dailyDirection].some(
    (value) => value !== null && value !== direction,
  );
  const marketRegime = getMarketRegime(aggregateClosed(marketSource, 60));
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
  score += marketRegime === direction ? 8 : marketRegime === "NEUTRAL" ? 0 : -12;
  if (rangeToAtr <= 2.5) score += 4;
  if (rangeToAtr > 3) score -= 8;
  const effectiveThreshold = Math.max(
    threshold,
    trendOpposed && !trendAligned ? 90 : agreement.length >= 2 ? 80 : 85,
  );
  const stop = direction === "BUY"
    ? Math.min(levels.swingLow ?? current.close - currentAtr, current.close - currentAtr * 0.8)
    : Math.max(levels.swingHigh ?? current.close + currentAtr, current.close + currentAtr * 0.8);
  const risk = Math.abs(current.close - stop);
  const target = direction === "BUY" ? current.close + risk * 2 : current.close - risk * 2;
  const roundTripCost = current.close * (COST_PERCENT / 100);
  const netRewardRisk =
    risk + roundTripCost > 0
      ? (Math.abs(target - current.close) - roundTripCost) / (risk + roundTripCost)
      : 0;
  const rejected =
    range.strength === "Weak" ||
    !breakout ||
    !volumeConfirmed ||
    (!levels.choch && !(breakoutMetrics.impulseConfirmed && trendAligned)) ||
    !trendAligned ||
    (marketRegime !== "NEUTRAL" && marketRegime !== direction) ||
    !breakoutMetrics.impulseConfirmed ||
    rangeToAtr > 3.5 ||
    netRewardRisk < 1.65 ||
    score < effectiveThreshold;
  if (rejected) return null;
  return {
    ticker,
    direction,
    score: Math.min(100, Math.round(score)),
    threshold: effectiveThreshold,
    entry: current.close,
    stop,
    target,
    timestamp: current.timestamp,
    netRewardRisk,
  };
}

function evaluate(candidate: Candidate, candles: Candle[], end: Date): EvaluatedTrade | null {
  const deadline = new Date(candidate.timestamp.getTime() + HORIZON_MINUTES * 60_000);
  if (deadline > end) return null;
  const future = candles.filter(
    (row) => row.timestamp > candidate.timestamp && row.timestamp <= deadline,
  );
  if (!future.length) return null;
  let last: Candle | null = null;
  for (const candle of future) {
    last = candle;
    const hitTarget =
      candidate.direction === "BUY"
        ? candle.high >= candidate.target
        : candle.low <= candidate.target;
    const hitStop =
      candidate.direction === "BUY"
        ? candle.low <= candidate.stop
        : candle.high >= candidate.stop;
    if (hitTarget || hitStop) {
      const isWin = hitTarget && !hitStop;
      const exitPrice = isWin ? candidate.target : candidate.stop;
      const gross =
        candidate.direction === "BUY"
          ? ((exitPrice - candidate.entry) / candidate.entry) * 100
          : ((candidate.entry - exitPrice) / candidate.entry) * 100;
      return {
        ...candidate,
        outcome: isWin ? "TP" : "SL",
        outcomePercent: gross - COST_PERCENT,
        exitTimestamp: candle.timestamp,
        allocation: ALLOCATION,
      };
    }
  }
  if (!last || last.timestamp < deadline) return null;
  const gross =
    candidate.direction === "BUY"
      ? ((last.close - candidate.entry) / candidate.entry) * 100
      : ((candidate.entry - last.close) / candidate.entry) * 100;
  const net = gross - COST_PERCENT;
  return {
    ...candidate,
    outcome: net >= 0 ? "TIMEOUT_WIN" : "TIMEOUT_LOSS",
    outcomePercent: net,
    exitTimestamp: last.timestamp,
    allocation: ALLOCATION,
  };
}

function number(value: unknown) {
  return Number(value);
}

async function main() {
  const activeRows = await db
    .select({ ticker: moexTickers.secid })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(asc(moexTickers.rank));
  const tickers = activeRows.map((row) => row.ticker).filter((ticker) => ticker !== "IMOEX");
  const thresholdResult = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE outcome IN ('TP', 'MANUAL_WIN', 'TIMEOUT_WIN'))::int AS wins
    FROM signals_history
    WHERE metadata ->> 'source' = 'smartmoney'
      AND outcome IS NOT NULL
      AND generated_at >= NOW() - INTERVAL '90 days'
  `);
  const thresholdRow = (thresholdResult.rows[0] ?? {}) as Record<string, unknown>;
  const historicalTotal = number(thresholdRow.total);
  const historicalWins = number(thresholdRow.wins);
  const adaptiveThreshold =
    historicalTotal < 20 ? 80 : historicalWins / historicalTotal < 0.45 ? 90 : historicalWins / historicalTotal > 0.65 ? 78 : 82;
  const rowsResult = await db.execute(sql`
    SELECT ticker, timeframe, timestamp, open, high, low, close, volume
    FROM candles
    WHERE timeframe IN ('1m', '1h')
    ORDER BY ticker, timeframe, timestamp
  `);
  const rows = rowsResult.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      ticker: String(row.ticker),
      timeframe: String(row.timeframe),
      timestamp: new Date(String(row.timestamp)),
      open: number(row.open),
      high: number(row.high),
      low: number(row.low),
      close: number(row.close),
      volume: number(row.volume) || 0,
    };
  });
  const byKey = new Map<string, Candle[]>();
  for (const row of rows) {
    const key = `${row.ticker}:${row.timeframe}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  const primary = new Map<string, Candle[]>();
  const thirty = new Map<string, Candle[]>();
  const oneHour = new Map<string, Candle[]>();
  for (const ticker of [...tickers, "IMOEX"]) {
    const minuteRows = byKey.get(`${ticker}:1m`) ?? [];
    primary.set(ticker, aggregate(minuteRows, 15));
    thirty.set(ticker, aggregate(minuteRows, 30));
    oneHour.set(ticker, byKey.get(`${ticker}:1h`) ?? []);
  }
  const allMinute = rows.filter((row) => row.timeframe === "1m");
  const maxMinute = allMinute.reduce((latest, row) => Math.max(latest, row.timestamp.getTime()), 0);
  const minMinute = allMinute.reduce((earliest, row) => Math.min(earliest, row.timestamp.getTime()), Number.POSITIVE_INFINITY);
  const backtestEnd = new Date(maxMinute - HORIZON_MINUTES * 60_000);
  const backtestStart = new Date(Math.max(minMinute, backtestEnd.getTime() - 90 * 24 * 60 * 60_000));
  const marketRows = oneHour.get("IMOEX") ?? [];
  const candidates: Candidate[] = [];
  for (const ticker of tickers) {
    const primaryRows = primary.get(ticker) ?? [];
    const hourlyRows = oneHour.get(ticker) ?? [];
    const times = primaryRows
      .filter((row) => row.timestamp >= backtestStart && row.timestamp <= backtestEnd)
      .map((row) => new Date(row.timestamp.getTime() + 15 * 60_000));
    for (const boundary of times) {
      const candidate = candidateAt(
        ticker,
        primaryRows,
        thirty.get(ticker) ?? [],
        hourlyRows,
        marketRows,
        adaptiveThreshold,
        boundary,
      );
      if (!candidate) continue;
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const selected: Candidate[] = [];
  const lastTimestamp = new Map<string, number>();
  let groupStart = 0;
  while (groupStart < candidates.length) {
    const timestamp = candidates[groupStart].timestamp.getTime();
    let groupEnd = groupStart + 1;
    while (
      groupEnd < candidates.length &&
      candidates[groupEnd].timestamp.getTime() === timestamp
    ) {
      groupEnd += 1;
    }
    const group = candidates
      .slice(groupStart, groupEnd)
      .sort((left, right) => right.score - left.score);
    for (const candidate of group) {
      if (selected.filter((item) => item.timestamp.getTime() === timestamp).length >= 5) {
        break;
      }
      const previous = lastTimestamp.get(candidate.ticker);
      if (previous !== undefined && timestamp - previous < 90 * 60_000) continue;
      selected.push(candidate);
      lastTimestamp.set(candidate.ticker, timestamp);
    }
    groupStart = groupEnd;
  }
  const evaluated: EvaluatedTrade[] = [];
  for (const candidate of selected) {
    const result = evaluate(candidate, byKey.get(`${candidate.ticker}:1m`) ?? [], backtestEnd);
    if (result) evaluated.push(result);
  }
  evaluated.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const active: EvaluatedTrade[] = [];
  const portfolioTrades: EvaluatedTrade[] = [];
  let skippedCapacity = 0;
  for (const trade of evaluated) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].exitTimestamp <= trade.timestamp) active.splice(index, 1);
    }
    if (active.length >= MAX_POSITIONS) {
      skippedCapacity += 1;
      continue;
    }
    active.push(trade);
    portfolioTrades.push(trade);
  }
  const wins = portfolioTrades.filter((trade) => trade.outcome === "TP" || trade.outcome === "TIMEOUT_WIN");
  const losses = portfolioTrades.length - wins.length;
  const pnl = portfolioTrades.reduce((sum, trade) => sum + trade.allocation * trade.outcomePercent / 100, 0);
  const byTicker = new Map<string, EvaluatedTrade[]>();
  for (const trade of portfolioTrades) {
    const list = byTicker.get(trade.ticker) ?? [];
    list.push(trade);
    byTicker.set(trade.ticker, list);
  }
  const tickerStats = [...byTicker.entries()]
    .map(([ticker, trades]) => {
      const tickerWins = trades.filter((trade) => trade.outcome === "TP" || trade.outcome === "TIMEOUT_WIN").length;
      const tickerPnl = trades.reduce((sum, trade) => sum + trade.allocation * trade.outcomePercent / 100, 0);
      return {
        ticker,
        trades: trades.length,
        wins: tickerWins,
        losses: trades.length - tickerWins,
        winRate: (tickerWins / trades.length) * 100,
        pnl: tickerPnl,
      };
    })
    .sort((left, right) => right.pnl - left.pnl);
  console.log(JSON.stringify({
    window: { start: backtestStart.toISOString(), end: backtestEnd.toISOString() },
    data: { tickers: tickers.length, oneMinuteRows: allMinute.length, threshold: adaptiveThreshold },
    candidates: candidates.length,
    evaluated: evaluated.length,
    portfolioTrades: portfolioTrades.length,
    skippedCapacity,
    wins: wins.length,
    losses,
    winRate: portfolioTrades.length ? (wins.length / portfolioTrades.length) * 100 : null,
    averageTradePercent: portfolioTrades.length ? portfolioTrades.reduce((sum, trade) => sum + trade.outcomePercent, 0) / portfolioTrades.length : null,
    portfolio: {
      initial: PORTFOLIO,
      allocationPerTrade: ALLOCATION,
      pnl,
      final: PORTFOLIO + pnl,
      returnPercent: (pnl / PORTFOLIO) * 100,
    },
    outcomes: {
      tp: portfolioTrades.filter((trade) => trade.outcome === "TP").length,
      sl: portfolioTrades.filter((trade) => trade.outcome === "SL").length,
      timeoutWin: portfolioTrades.filter((trade) => trade.outcome === "TIMEOUT_WIN").length,
      timeoutLoss: portfolioTrades.filter((trade) => trade.outcome === "TIMEOUT_LOSS").length,
    },
    byTicker: tickerStats,
    note: "Same Smart Money filters reproduced in a separate historical runner; round-trip cost 0.2%, both TP and SL in one candle count as SL, max 5 simultaneous positions, 20,000 RUB per position.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});