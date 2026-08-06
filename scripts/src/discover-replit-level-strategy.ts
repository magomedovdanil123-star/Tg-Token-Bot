import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

type Direction = "BUY" | "SELL";
type Candle = {
  ticker: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Pivot = {
  index: number;
  price: number;
};

type Level = {
  price: number;
  touches: number;
};

type Snapshot = {
  support: Level | null;
  resistance: Level | null;
};

type Event = {
  ticker: string;
  index: number;
  timestamp: Date;
  direction: Direction;
  pattern: string;
  level: number;
  touches: number;
};

type Outcome = {
  value: number;
  win: boolean;
};

type Stats = {
  pattern: string;
  direction: Direction;
  take: number;
  stop: number;
  horizon: number;
  total: number;
  wins: number;
  sum: number;
  positive: number;
  negative: number;
  trainTotal: number;
  trainWins: number;
  trainSum: number;
  testTotal: number;
  testWins: number;
  testSum: number;
  drawdown: number;
};

const TIMEFRAME = "1h";
const TRAIN_CUTOFF = new Date("2026-01-01T00:00:00.000Z");
const COST_PERCENT = 0.1;
const COOLDOWN_BARS = 12;
const LOOKBACKS = [48, 72];
const CLUSTER_TOLERANCES = [0.004];
const MIN_TOUCHES = [2, 3];
const BOUNCE_TOLERANCES = [0.002];
const BOUNCE_CONFIRMATIONS = [0, 0.001];
const BREAK_THRESHOLDS = [0.002, 0.005];
const TAKE_PROFITS = [0.75, 1, 1.5];
const STOP_LOSSES = [0.75, 1, 1.5];
const HORIZONS = [12, 24];

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadCandles() {
  const result = await db.execute(sql`
    SELECT c.ticker, c.timestamp, c.open, c.high, c.low, c.close, c.volume
    FROM candles c
    INNER JOIN moex_tickers t
      ON t.secid = c.ticker
     AND t.is_active = true
    WHERE c.timeframe = ${TIMEFRAME}
      AND c.ticker <> 'IMOEX'
    ORDER BY c.ticker, c.timestamp
  `);
  const groups = new Map<string, Candle[]>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const timestamp = new Date(String(row.timestamp));
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    const volume = num(row.volume);
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

function pivots(rows: Candle[]) {
  const supports: Pivot[] = [];
  const resistances: Pivot[] = [];
  for (let index = 2; index < rows.length - 2; index += 1) {
    const row = rows[index];
    let isLow = true;
    let isHigh = true;
    for (let offset = -2; offset <= 2; offset += 1) {
      if (offset === 0) continue;
      if (rows[index + offset].low < row.low) isLow = false;
      if (rows[index + offset].high > row.high) isHigh = false;
    }
    if (isLow) supports.push({ index, price: row.low });
    if (isHigh) resistances.push({ index, price: row.high });
  }
  return { supports, resistances };
}

function strongestLevel(
  candidates: Pivot[],
  index: number,
  lookback: number,
  tolerance: number,
  minTouches: number,
): Level | null {
  const available = candidates
    .filter(
    (pivot) => pivot.index <= index - 2 && pivot.index >= index - lookback,
    )
    .sort((left, right) => left.price - right.price);
  let best: Level | null = null;
  let right = 0;
  for (let left = 0; left < available.length; left += 1) {
    const anchor = available[left].price;
    while (
      right < available.length &&
      available[right].price <= anchor * (1 + tolerance)
    ) {
      right += 1;
    }
    const cluster = available.slice(left, right);
    if (cluster.length < minTouches) continue;
    const price =
      cluster.reduce((sum, pivot) => sum + pivot.price, 0) / cluster.length;
    const level = { price, touches: cluster.length };
    if (
      best === null ||
      level.touches > best.touches ||
      (level.touches === best.touches && price < best.price)
    ) {
      best = level;
    }
  }
  return best;
}

function buildSnapshots(
  rows: Candle[],
  lookback: number,
  tolerance: number,
  minTouches: number,
) {
  const { supports, resistances } = pivots(rows);
  const snapshots: Snapshot[] = Array.from({ length: rows.length }, () => ({
    support: null,
    resistance: null,
  }));
  for (let index = lookback; index < rows.length; index += 1) {
    snapshots[index] = {
      support: strongestLevel(
        supports,
        index,
        lookback,
        tolerance,
        minTouches,
      ),
      resistance: strongestLevel(
        resistances,
        index,
        lookback,
        tolerance,
        minTouches,
      ),
    };
  }
  return snapshots;
}

function detectEvents(
  rows: Candle[],
  snapshots: Snapshot[],
  bounceTolerance: number,
  bounceConfirmation: number,
  breakThreshold: number,
  detectorName: string,
) {
  const events: Event[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    const snapshot = snapshots[index];
    const bodyPosition =
      row.high > row.low ? (row.close - row.open) / (row.high - row.low) : 0;
    const support = snapshot.support;
    const resistance = snapshot.resistance;

    if (
      support &&
      row.low <= support.price * (1 + bounceTolerance) &&
      row.close >= support.price * (1 + bounceConfirmation) &&
      row.close > row.open &&
      bodyPosition >= 0.1
    ) {
      events.push({
        ticker: row.ticker,
        index,
        timestamp: row.timestamp,
        direction: "BUY",
        pattern: `${detectorName}:bounce_support_${bounceTolerance}_${bounceConfirmation}`,
        level: support.price,
        touches: support.touches,
      });
    }
    if (
      resistance &&
      row.high >= resistance.price * (1 - bounceTolerance) &&
      row.close <= resistance.price * (1 - bounceConfirmation) &&
      row.close < row.open &&
      bodyPosition <= -0.1
    ) {
      events.push({
        ticker: row.ticker,
        index,
        timestamp: row.timestamp,
        direction: "SELL",
        pattern: `${detectorName}:bounce_resistance_${bounceTolerance}_${bounceConfirmation}`,
        level: resistance.price,
        touches: resistance.touches,
      });
    }
    if (
      resistance &&
      previous.close <= resistance.price &&
      row.close >= resistance.price * (1 + breakThreshold) &&
      row.close > row.open &&
      bodyPosition >= 0.25
    ) {
      events.push({
        ticker: row.ticker,
        index,
        timestamp: row.timestamp,
        direction: "BUY",
        pattern: `${detectorName}:break_resistance_${breakThreshold}`,
        level: resistance.price,
        touches: resistance.touches,
      });
    }
    if (
      support &&
      previous.close >= support.price &&
      row.close <= support.price * (1 - breakThreshold) &&
      row.close < row.open &&
      bodyPosition <= -0.25
    ) {
      events.push({
        ticker: row.ticker,
        index,
        timestamp: row.timestamp,
        direction: "SELL",
        pattern: `${detectorName}:break_support_${breakThreshold}`,
        level: support.price,
        touches: support.touches,
      });
    }
  }
  return events;
}

function evaluate(
  rows: Candle[],
  event: Event,
  take: number,
  stop: number,
  horizon: number,
): Outcome | null {
  const entry = rows[event.index]?.close;
  const last = event.index + horizon;
  if (!entry || last >= rows.length) return null;
  const target =
    event.direction === "BUY" ? entry * (1 + take / 100) : entry * (1 - take / 100);
  const stopPrice =
    event.direction === "BUY" ? entry * (1 - stop / 100) : entry * (1 + stop / 100);
  for (let index = event.index + 1; index <= last; index += 1) {
    const candle = rows[index];
    const hitTarget =
      event.direction === "BUY"
        ? candle.high >= target
        : candle.low <= target;
    const hitStop =
      event.direction === "BUY"
        ? candle.low <= stopPrice
        : candle.high >= stopPrice;
    if (hitTarget || hitStop) {
      const win = hitTarget && !hitStop;
      return {
        value: (win ? take : -stop) - COST_PERCENT,
        win,
      };
    }
  }
  const close = rows[last].close;
  const timeout =
    event.direction === "BUY"
      ? (close / entry - 1) * 100
      : (1 - close / entry) * 100;
  const value = timeout - COST_PERCENT;
  return { value, win: value > 0 };
}

function emptyStats(
  pattern: string,
  direction: Direction,
  take: number,
  stop: number,
  horizon: number,
): Stats {
  return {
    pattern,
    direction,
    take,
    stop,
    horizon,
    total: 0,
    wins: 0,
    sum: 0,
    positive: 0,
    negative: 0,
    trainTotal: 0,
    trainWins: 0,
    trainSum: 0,
    testTotal: 0,
    testWins: 0,
    testSum: 0,
    drawdown: 0,
  };
}

function update(stats: Stats, outcome: Outcome, train: boolean, equity: { value: number; peak: number }) {
  stats.total += 1;
  stats.wins += outcome.win ? 1 : 0;
  stats.sum += outcome.value;
  if (outcome.value > 0) stats.positive += outcome.value;
  else stats.negative += outcome.value;
  equity.value += outcome.value;
  equity.peak = Math.max(equity.peak, equity.value);
  stats.drawdown = Math.max(stats.drawdown, equity.peak - equity.value);
  if (train) {
    stats.trainTotal += 1;
    stats.trainWins += outcome.win ? 1 : 0;
    stats.trainSum += outcome.value;
  } else {
    stats.testTotal += 1;
    stats.testWins += outcome.win ? 1 : 0;
    stats.testSum += outcome.value;
  }
}

function summarize(stats: Stats) {
  return {
    ...stats,
    winRate: stats.total ? stats.wins / stats.total : 0,
    expectancy: stats.total ? stats.sum / stats.total : 0,
    profitFactor:
      stats.negative < 0 ? stats.positive / Math.abs(stats.negative) : null,
    trainWinRate: stats.trainTotal ? stats.trainWins / stats.trainTotal : 0,
    trainExpectancy: stats.trainTotal ? stats.trainSum / stats.trainTotal : 0,
    testWinRate: stats.testTotal ? stats.testWins / stats.testTotal : 0,
    testExpectancy: stats.testTotal ? stats.testSum / stats.testTotal : 0,
  };
}

function statsFor(
  events: Event[],
  rows: Candle[],
  take: number,
  stop: number,
  horizon: number,
  cache: Map<string, Outcome | null>,
) {
  const first = events[0];
  const stats = emptyStats(
    first?.pattern ?? "unknown",
    first?.direction ?? "BUY",
    take,
    stop,
    horizon,
  );
  let lastAccepted = -Infinity;
  const equity = { value: 0, peak: 0 };
  for (const event of events) {
    if (event.index - lastAccepted < COOLDOWN_BARS) continue;
    const key = `${event.ticker}|${event.index}|${event.direction}|${take}|${stop}|${horizon}`;
    let outcome = cache.get(key);
    if (outcome === undefined) {
      outcome = evaluate(rows, event, take, stop, horizon);
      cache.set(key, outcome);
    }
    if (outcome === null) continue;
    lastAccepted = event.index;
    update(stats, outcome, event.timestamp < TRAIN_CUTOFF, equity);
  }
  return stats;
}

async function main() {
  const groups = await loadCandles();
  const allResults: ReturnType<typeof summarize>[] = [];
  let eventsTotal = 0;
  for (const [ticker, rows] of groups) {
    if (rows.length < 100) continue;
    for (const lookback of LOOKBACKS) {
      for (const clusterTolerance of CLUSTER_TOLERANCES) {
        for (const minTouches of MIN_TOUCHES) {
          const snapshots = buildSnapshots(
            rows,
            lookback,
            clusterTolerance,
            minTouches,
          );
          for (const bounceTolerance of BOUNCE_TOLERANCES) {
            for (const bounceConfirmation of BOUNCE_CONFIRMATIONS) {
              for (const breakThreshold of BREAK_THRESHOLDS) {
                const events = detectEvents(
                  rows,
                  snapshots,
                  bounceTolerance,
                  bounceConfirmation,
                  breakThreshold,
                  `lb${lookback}_cluster${clusterTolerance}_touches${minTouches}`,
                );
                eventsTotal += events.length;
                const byPattern = new Map<string, Event[]>();
                for (const event of events) {
                  const list = byPattern.get(event.pattern) ?? [];
                  list.push(event);
                  byPattern.set(event.pattern, list);
                }
                for (const [pattern, patternEvents] of byPattern) {
                  const cache = new Map<string, Outcome | null>();
                  for (const take of TAKE_PROFITS) {
                    for (const stop of STOP_LOSSES) {
                      for (const horizon of HORIZONS) {
                        const stats = statsFor(
                          patternEvents,
                          rows,
                          take,
                          stop,
                          horizon,
                          cache,
                        );
                        if (
                          stats.total >= 30 &&
                          stats.trainTotal >= 15 &&
                          stats.testTotal >= 15
                        ) {
                          allResults.push(summarize(stats));
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  allResults.sort(
    (a, b) =>
      b.testExpectancy - a.testExpectancy ||
      b.testWinRate - a.testWinRate ||
      (b.profitFactor ?? 0) - (a.profitFactor ?? 0),
  );
  console.log(
    JSON.stringify(
      {
        timeframe: TIMEFRAME,
        trainCutoff: TRAIN_CUTOFF.toISOString(),
        costsPercent: COST_PERCENT,
        cooldownBars: COOLDOWN_BARS,
        eventsTotal,
        candidates: allResults.length,
        topByTestExpectancy: allResults.slice(0, 40),
        topByTestWinRate: [...allResults]
          .sort((a, b) => b.testWinRate - a.testWinRate)
          .slice(0, 20),
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