import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const TIMEFRAME = "10m";
const MAX_ANALOGS = 15;
const MIN_ANALOGS = 5;
const LOOKBACK_DAYS = 365;
const HORIZONS = {
  oneHour: 60 * 60 * 1000,
  threeHours: 3 * 60 * 60 * 1000,
  sixHours: 6 * 60 * 60 * 1000,
  oneDay: 24 * 60 * 60 * 1000,
  fiveDays: 5 * 24 * 60 * 60 * 1000,
  tenDays: 10 * 24 * 60 * 60 * 1000,
} as const;

type SnapshotRow = {
  ticker: string;
  timestamp: Date;
  price: number;
  dayChange: number | null;
  volume: number | null;
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  macdHist: number | null;
  atr: number | null;
  vwap: number | null;
  distanceToHigh: number | null;
  distanceToLow: number | null;
  change60: number | null;
  acceleration: number | null;
  relativeVolume: number | null;
};

type MarketVector = {
  coverage: number;
  avgChange60: number;
  breadth: number;
  avgRsi: number;
  avgEma20Gap: number;
  avgEma50Gap: number;
  avgEma200Gap: number;
  avgMacd: number;
  avgAtr: number;
  avgVwapGap: number;
  avgAcceleration: number;
  avgRelativeVolume: number;
  dispersion: number;
};

type HistoricalVector = MarketVector & { timestamp: Date };

type AnalogMatch = {
  historicalDate: Date;
  similarity: number;
  result1h: number | null;
  result3h: number | null;
  result6h: number | null;
  result1d: number | null;
  result5d: number | null;
  result10d: number | null;
};

type CandlePoint = { timestamp: Date; close: number };
type CurrentIndex = { timestamp: Date; price: number };

type StockAnalogStat = {
  ticker: string;
  currentPrice: number | null;
  cases: number;
  upCases: number;
  downCases: number;
  average1h: number | null;
  average3h: number | null;
  average6h: number | null;
  average5d: number | null;
  averageUp5d: number | null;
  averageDown5d: number | null;
  maxUp5d: number | null;
  maxDown5d: number | null;
  stddev5d: number | null;
  stability: "Высокая" | "Средняя" | "Низкая";
};

type StockAnalogMatch = {
  ticker: string;
  historicalDate: Date;
  similarity: number;
  priceAtAnalogue: number | null;
  price1h: number | null;
  price3h: number | null;
  price6h: number | null;
  price1d: number | null;
  price5d: number | null;
  result1h: number | null;
  result3h: number | null;
  result6h: number | null;
  result1d: number | null;
  result5d: number | null;
  direction: "LONG" | "SHORT" | "нет данных";
};

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(value: Date) {
  return value.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function ensureSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id BIGSERIAL PRIMARY KEY,
      snapshot_datetime TIMESTAMPTZ NOT NULL,
      ticker VARCHAR(32) NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      day_change_percent DOUBLE PRECISION,
      volume DOUBLE PRECISION,
      indicators JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS market_snapshots_datetime_ticker_uq
      ON market_snapshots (snapshot_datetime, ticker)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS market_snapshots_datetime_idx
      ON market_snapshots (snapshot_datetime DESC)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS analog_matches (
      id BIGSERIAL PRIMARY KEY,
      snapshot_date TIMESTAMPTZ NOT NULL,
      historical_date TIMESTAMPTZ NOT NULL,
      similarity_score DOUBLE PRECISION NOT NULL,
      market_result_1h DOUBLE PRECISION,
      market_result_3h DOUBLE PRECISION,
      market_result_6h DOUBLE PRECISION,
      market_result_1d DOUBLE PRECISION,
      market_result_5d DOUBLE PRECISION,
      market_result_10d DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    ALTER TABLE analog_matches
      ADD COLUMN IF NOT EXISTS market_result_3h DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS market_result_6h DOUBLE PRECISION
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS analog_matches_current_history_uq
      ON analog_matches (snapshot_date, historical_date)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS analog_stock_matches (
      id BIGSERIAL PRIMARY KEY,
      snapshot_date TIMESTAMPTZ NOT NULL,
      historical_date TIMESTAMPTZ NOT NULL,
      ticker VARCHAR(32) NOT NULL,
      similarity_score DOUBLE PRECISION NOT NULL,
      price_at_analogue DOUBLE PRECISION,
      price_1h DOUBLE PRECISION,
      price_3h DOUBLE PRECISION,
      price_6h DOUBLE PRECISION,
      price_1d DOUBLE PRECISION,
      price_5d DOUBLE PRECISION,
      result_1h DOUBLE PRECISION,
      result_3h DOUBLE PRECISION,
      result_6h DOUBLE PRECISION,
      result_1d DOUBLE PRECISION,
      result_5d DOUBLE PRECISION,
      direction VARCHAR(8),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    ALTER TABLE analog_stock_matches
      ADD COLUMN IF NOT EXISTS price_1h DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS price_3h DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS price_6h DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS result_1h DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS result_3h DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS result_6h DOUBLE PRECISION
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS analog_stock_matches_uq
      ON analog_stock_matches (snapshot_date, historical_date, ticker)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS analog_stock_matches_snapshot_ticker_idx
      ON analog_stock_matches (snapshot_date, ticker)
  `);
}

async function loadCurrentSnapshot(): Promise<SnapshotRow[]> {
  const result = await db.execute(sql`
    WITH active AS (
      SELECT secid
      FROM moex_tickers
      WHERE is_active = true AND secid <> 'IMOEX'
    )
    SELECT
      a.secid AS ticker,
      c.timestamp,
      c.close AS price,
      CASE
        WHEN previous.close IS NULL OR previous.close = 0 THEN NULL
        ELSE (c.close / previous.close - 1) * 100
      END AS "dayChange",
      c.volume,
      f.rsi,
      f.ema_20 AS "ema20",
      f.ema_50 AS "ema50",
      f.ema_200 AS "ema200",
      f.macd_hist AS "macdHist",
      f.atr,
      f.vwap,
      f.distance_to_high AS "distanceToHigh",
      f.distance_to_low AS "distanceToLow",
      f.price_change_60 AS "change60",
      f.acceleration,
      f.relative_volume AS "relativeVolume"
    FROM active a
    CROSS JOIN LATERAL (
      SELECT c.*
      FROM candles c
      WHERE c.ticker = a.secid AND c.timeframe = ${TIMEFRAME}
      ORDER BY c.timestamp DESC
      LIMIT 1
    ) c
    LEFT JOIN features f
      ON f.ticker = c.ticker AND f.timestamp = c.timestamp
    LEFT JOIN LATERAL (
      SELECT previous.close
      FROM candles previous
      WHERE previous.ticker = c.ticker
        AND previous.timeframe = ${TIMEFRAME}
        AND previous.timestamp <= c.timestamp - INTERVAL '1 day'
      ORDER BY previous.timestamp DESC
      LIMIT 1
    ) previous ON true
    ORDER BY a.secid
  `);
  return result.rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      const timestamp = asDate(record.timestamp);
      const price = numeric(record.price);
      if (!timestamp || price === null) return null;
      return {
        ticker: String(record.ticker),
        timestamp,
        price,
        dayChange: numeric(record.dayChange),
        volume: numeric(record.volume),
        rsi: numeric(record.rsi),
        ema20: numeric(record.ema20),
        ema50: numeric(record.ema50),
        ema200: numeric(record.ema200),
        macdHist: numeric(record.macdHist),
        atr: numeric(record.atr),
        vwap: numeric(record.vwap),
        distanceToHigh: numeric(record.distanceToHigh),
        distanceToLow: numeric(record.distanceToLow),
        change60: numeric(record.change60),
        acceleration: numeric(record.acceleration),
        relativeVolume: numeric(record.relativeVolume),
      };
    })
    .filter((row): row is SnapshotRow => row !== null);
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function marketVector(rows: SnapshotRow[]): MarketVector {
  const changes = rows.map((row) => row.change60);
  const validChanges = changes.filter((value): value is number => value !== null);
  const avgChange60 = average(changes);
  const dispersion = validChanges.length
    ? Math.sqrt(
        validChanges.reduce((sum, value) => sum + (value - avgChange60) ** 2, 0) /
          validChanges.length,
      )
    : 0;
  return {
    coverage: rows.length,
    avgChange60,
    breadth: validChanges.length
      ? validChanges.filter((value) => value >= 0).length / validChanges.length
      : 0.5,
    avgRsi: average(rows.map((row) => row.rsi)),
    avgEma20Gap: average(
      rows.map((row) => (row.ema20 && row.price ? (row.price / row.ema20 - 1) * 100 : null)),
    ),
    avgEma50Gap: average(
      rows.map((row) => (row.ema50 && row.price ? (row.price / row.ema50 - 1) * 100 : null)),
    ),
    avgEma200Gap: average(
      rows.map((row) => (row.ema200 && row.price ? (row.price / row.ema200 - 1) * 100 : null)),
    ),
    avgMacd: average(
      rows.map((row) => (row.macdHist && row.price ? (row.macdHist / row.price) * 100 : null)),
    ),
    avgAtr: average(
      rows.map((row) => (row.atr && row.price ? (row.atr / row.price) * 100 : null)),
    ),
    avgVwapGap: average(
      rows.map((row) => (row.vwap && row.price ? (row.price / row.vwap - 1) * 100 : null)),
    ),
    avgAcceleration: average(
      rows.map((row) =>
        row.acceleration && row.price ? (row.acceleration / row.price) * 100 : null,
      ),
    ),
    avgRelativeVolume: average(rows.map((row) => row.relativeVolume)),
    dispersion,
  };
}

async function saveSnapshot(rows: SnapshotRow[], snapshotDate: Date) {
  for (const row of rows) {
    await db.execute(sql`
      INSERT INTO market_snapshots (
        snapshot_datetime, ticker, price, day_change_percent, volume, indicators
      )
      VALUES (
        ${snapshotDate},
        ${row.ticker},
        ${row.price},
        ${row.dayChange},
        ${row.volume},
        ${JSON.stringify({
          rsi: row.rsi,
          ema20: row.ema20,
          ema50: row.ema50,
          ema200: row.ema200,
          macdHist: row.macdHist,
          atr: row.atr,
          vwap: row.vwap,
          distanceToHigh: row.distanceToHigh,
          distanceToLow: row.distanceToLow,
          change60: row.change60,
          acceleration: row.acceleration,
          relativeVolume: row.relativeVolume,
        })}::jsonb
      )
      ON CONFLICT (snapshot_datetime, ticker) DO UPDATE SET
        price = EXCLUDED.price,
        day_change_percent = EXCLUDED.day_change_percent,
        volume = EXCLUDED.volume,
        indicators = EXCLUDED.indicators
    `);
  }
}

async function loadHistoricalVectors(
  currentDate: Date,
): Promise<HistoricalVector[]> {
  const result = await db.execute(sql`
    SELECT
      f.timestamp,
      COUNT(*)::int AS coverage,
      AVG(f.price_change_60) AS "avgChange60",
      AVG(CASE WHEN f.price_change_60 >= 0 THEN 1.0 ELSE 0.0 END) AS breadth,
      AVG(f.rsi) AS "avgRsi",
      AVG(CASE WHEN f.ema_20 <> 0 THEN (c.close / f.ema_20 - 1) * 100 END) AS "avgEma20Gap",
      AVG(CASE WHEN f.ema_50 <> 0 THEN (c.close / f.ema_50 - 1) * 100 END) AS "avgEma50Gap",
      AVG(CASE WHEN f.ema_200 <> 0 THEN (c.close / f.ema_200 - 1) * 100 END) AS "avgEma200Gap",
      AVG(CASE WHEN c.close <> 0 THEN (f.macd_hist / c.close) * 100 END) AS "avgMacd",
      AVG(CASE WHEN c.close <> 0 THEN (f.atr / c.close) * 100 END) AS "avgAtr",
      AVG(CASE WHEN f.vwap <> 0 THEN (c.close / f.vwap - 1) * 100 END) AS "avgVwapGap",
      AVG(CASE WHEN c.close <> 0 THEN (f.acceleration / c.close) * 100 END) AS "avgAcceleration",
      AVG(f.relative_volume) AS "avgRelativeVolume",
      STDDEV_POP(f.price_change_60) AS dispersion
    FROM features f
    INNER JOIN candles c
      ON c.ticker = f.ticker
      AND c.timeframe = ${TIMEFRAME}
      AND c.timestamp = f.timestamp
    INNER JOIN moex_tickers t
      ON t.secid = f.ticker AND t.is_active = true AND t.secid <> 'IMOEX'
    WHERE f.timestamp >= ${new Date(currentDate.getTime() - LOOKBACK_DAYS * 86400000)}
      AND f.timestamp <= ${new Date(currentDate.getTime() - HORIZONS.fiveDays)}
    GROUP BY f.timestamp
    HAVING COUNT(*) >= 30
    ORDER BY f.timestamp
  `);
  return result.rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      const timestamp = asDate(record.timestamp);
      if (!timestamp) return null;
      const value = (key: string) => numeric(record[key]) ?? 0;
      return {
        timestamp,
        coverage: Math.round(value("coverage")),
        avgChange60: value("avgChange60"),
        breadth: value("breadth"),
        avgRsi: value("avgRsi"),
        avgEma20Gap: value("avgEma20Gap"),
        avgEma50Gap: value("avgEma50Gap"),
        avgEma200Gap: value("avgEma200Gap"),
        avgMacd: value("avgMacd"),
        avgAtr: value("avgAtr"),
        avgVwapGap: value("avgVwapGap"),
        avgAcceleration: value("avgAcceleration"),
        avgRelativeVolume: value("avgRelativeVolume"),
        dispersion: value("dispersion"),
      };
    })
    .filter((row): row is HistoricalVector => row !== null);
}

function similarity(current: MarketVector, historical: HistoricalVector) {
  const differences = [
    Math.abs(current.avgChange60 - historical.avgChange60) / 3,
    Math.abs(current.breadth - historical.breadth) / 0.5,
    Math.abs(current.avgRsi - historical.avgRsi) / 20,
    Math.abs(current.avgEma20Gap - historical.avgEma20Gap) / 3,
    Math.abs(current.avgEma50Gap - historical.avgEma50Gap) / 5,
    Math.abs(current.avgEma200Gap - historical.avgEma200Gap) / 8,
    Math.abs(current.avgMacd - historical.avgMacd) / 0.5,
    Math.abs(current.avgAtr - historical.avgAtr) / 2,
    Math.abs(current.avgVwapGap - historical.avgVwapGap) / 3,
    Math.abs(current.avgAcceleration - historical.avgAcceleration) / 1,
    Math.abs(current.avgRelativeVolume - historical.avgRelativeVolume) / 1,
    Math.abs(current.dispersion - historical.dispersion) / 3,
  ];
  const distance = differences.reduce((sum, value) => sum + Math.min(value, 3), 0) / differences.length;
  return Math.max(0, Math.min(100, 100 - distance * 25));
}

async function loadImoexSeries(from: Date, to: Date) {
  const result = await db.execute(sql`
    SELECT timestamp, close
    FROM candles
    WHERE ticker = 'IMOEX'
      AND timeframe = ${TIMEFRAME}
      AND timestamp >= ${from}
      AND timestamp <= ${to}
    ORDER BY timestamp
  `);
  return result.rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      const timestamp = asDate(record.timestamp);
      const close = numeric(record.close);
      return timestamp && close !== null ? { timestamp, close } : null;
    })
    .filter((row): row is CandlePoint => row !== null);
}

async function loadCurrentImoex(atOrBefore: Date): Promise<CurrentIndex | null> {
  const result = await db.execute(sql`
    SELECT timestamp, close
    FROM candles
    WHERE ticker = 'IMOEX'
      AND timeframe = ${TIMEFRAME}
      AND timestamp <= ${atOrBefore}
    ORDER BY timestamp DESC
    LIMIT 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const timestamp = asDate(row.timestamp);
  const price = numeric(row.close);
  return timestamp && price !== null ? { timestamp, price } : null;
}

function closestBeforeOrAt(points: CandlePoint[], timestamp: Date) {
  let result: CandlePoint | null = null;
  for (const point of points) {
    if (point.timestamp.getTime() > timestamp.getTime()) break;
    result = point;
  }
  return result;
}

function closestAfterOrAt(points: CandlePoint[], timestamp: Date) {
  return points.find((point) => point.timestamp.getTime() >= timestamp.getTime()) ?? null;
}

function movement(before: CandlePoint | null, after: CandlePoint | null) {
  if (!before || !after || before.close === 0) return null;
  return (after.close / before.close - 1) * 100;
}

async function saveMatches(currentDate: Date, matches: AnalogMatch[]) {
  await db.execute(sql`
    DELETE FROM analog_matches
    WHERE snapshot_date = ${currentDate}
  `);
  for (const match of matches) {
    await db.execute(sql`
      INSERT INTO analog_matches (
        snapshot_date, historical_date, similarity_score,
        market_result_1h, market_result_3h, market_result_6h,
        market_result_1d, market_result_5d, market_result_10d
      )
      VALUES (
        ${currentDate}, ${match.historicalDate}, ${match.similarity},
        ${match.result1h}, ${match.result3h}, ${match.result6h},
        ${match.result1d}, ${match.result5d}, ${match.result10d}
      )
      ON CONFLICT (snapshot_date, historical_date) DO UPDATE SET
        similarity_score = EXCLUDED.similarity_score,
        market_result_1h = EXCLUDED.market_result_1h,
        market_result_3h = EXCLUDED.market_result_3h,
        market_result_6h = EXCLUDED.market_result_6h,
        market_result_1d = EXCLUDED.market_result_1d,
        market_result_5d = EXCLUDED.market_result_5d,
        market_result_10d = EXCLUDED.market_result_10d
    `);
  }
}

async function saveStockMatches(currentDate: Date) {
  await db.execute(sql`
    DELETE FROM analog_stock_matches
    WHERE snapshot_date = ${currentDate}
  `);
  await db.execute(sql`
    INSERT INTO analog_stock_matches (
      snapshot_date, historical_date, ticker, similarity_score,
      price_at_analogue, price_1h, price_3h, price_6h, price_1d, price_5d,
      result_1h, result_3h, result_6h, result_1d, result_5d, direction
    )
    SELECT
      ${currentDate},
      a.historical_date,
      t.secid,
      a.similarity_score,
      historical.close,
      one_hour.close,
      three_hours.close,
      six_hours.close,
      one_day.close,
      five_day.close,
      CASE
        WHEN historical.close IS NULL OR historical.close = 0 OR one_hour.close IS NULL THEN NULL
        ELSE (one_hour.close / historical.close - 1) * 100
      END,
      CASE
        WHEN historical.close IS NULL OR historical.close = 0 OR three_hours.close IS NULL THEN NULL
        ELSE (three_hours.close / historical.close - 1) * 100
      END,
      CASE
        WHEN historical.close IS NULL OR historical.close = 0 OR six_hours.close IS NULL THEN NULL
        ELSE (six_hours.close / historical.close - 1) * 100
      END,
      CASE
        WHEN historical.close IS NULL OR historical.close = 0 OR one_day.close IS NULL THEN NULL
        ELSE (one_day.close / historical.close - 1) * 100
      END,
      CASE
        WHEN historical.close IS NULL OR historical.close = 0 OR five_day.close IS NULL THEN NULL
        ELSE (five_day.close / historical.close - 1) * 100
      END,
      CASE
        WHEN historical.close IS NULL OR historical.close = 0 OR five_day.close IS NULL THEN NULL
        WHEN five_day.close >= historical.close THEN 'LONG'
        ELSE 'SHORT'
      END
    FROM analog_matches a
    CROSS JOIN moex_tickers t
    LEFT JOIN LATERAL (
      SELECT c.close
      FROM candles c
      WHERE c.ticker = t.secid
        AND c.timeframe = ${TIMEFRAME}
        AND c.timestamp >= a.historical_date + INTERVAL '1 hour'
      ORDER BY c.timestamp
      LIMIT 1
    ) one_hour ON true
    LEFT JOIN LATERAL (
      SELECT c.close
      FROM candles c
      WHERE c.ticker = t.secid
        AND c.timeframe = ${TIMEFRAME}
        AND c.timestamp >= a.historical_date + INTERVAL '3 hours'
      ORDER BY c.timestamp
      LIMIT 1
    ) three_hours ON true
    LEFT JOIN LATERAL (
      SELECT c.close
      FROM candles c
      WHERE c.ticker = t.secid
        AND c.timeframe = ${TIMEFRAME}
        AND c.timestamp >= a.historical_date + INTERVAL '6 hours'
      ORDER BY c.timestamp
      LIMIT 1
    ) six_hours ON true
    LEFT JOIN LATERAL (
      SELECT c.close
      FROM candles c
      WHERE c.ticker = t.secid
        AND c.timeframe = ${TIMEFRAME}
        AND c.timestamp <= a.historical_date
      ORDER BY c.timestamp DESC
      LIMIT 1
    ) historical ON true
    LEFT JOIN LATERAL (
      SELECT c.close
      FROM candles c
      WHERE c.ticker = t.secid
        AND c.timeframe = ${TIMEFRAME}
        AND c.timestamp >= a.historical_date + INTERVAL '1 day'
      ORDER BY c.timestamp
      LIMIT 1
    ) one_day ON true
    LEFT JOIN LATERAL (
      SELECT c.close
      FROM candles c
      WHERE c.ticker = t.secid
        AND c.timeframe = ${TIMEFRAME}
        AND c.timestamp >= a.historical_date + INTERVAL '5 days'
      ORDER BY c.timestamp
      LIMIT 1
    ) five_day ON true
    WHERE a.snapshot_date = ${currentDate}
      AND t.is_active = true
      AND t.secid <> 'IMOEX'
    ON CONFLICT (snapshot_date, historical_date, ticker) DO UPDATE SET
      similarity_score = EXCLUDED.similarity_score,
      price_at_analogue = EXCLUDED.price_at_analogue,
      price_1h = EXCLUDED.price_1h,
      price_3h = EXCLUDED.price_3h,
      price_6h = EXCLUDED.price_6h,
      price_1d = EXCLUDED.price_1d,
      price_5d = EXCLUDED.price_5d,
      result_1h = EXCLUDED.result_1h,
      result_3h = EXCLUDED.result_3h,
      result_6h = EXCLUDED.result_6h,
      result_1d = EXCLUDED.result_1d,
      result_5d = EXCLUDED.result_5d,
      direction = EXCLUDED.direction
  `);
}

async function loadStockMatches(currentDate: Date): Promise<StockAnalogMatch[]> {
  const result = await db.execute(sql`
    SELECT
      ticker,
      historical_date AS "historicalDate",
      similarity_score AS similarity,
      price_at_analogue AS "priceAtAnalogue",
      price_1h AS "price1h",
      price_3h AS "price3h",
      price_6h AS "price6h",
      price_1d AS "price1d",
      price_5d AS "price5d",
      result_1h AS "result1h",
      result_3h AS "result3h",
      result_6h AS "result6h",
      result_1d AS "result1d",
      result_5d AS "result5d",
      direction
    FROM analog_stock_matches
    WHERE snapshot_date = ${currentDate}
    ORDER BY historical_date, ticker
  `);
  return result.rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      const historicalDate = asDate(record.historicalDate);
      if (!historicalDate) return null;
      const rawDirection = String(record.direction ?? "");
      return {
        ticker: String(record.ticker),
        historicalDate,
        similarity: numeric(record.similarity) ?? 0,
        priceAtAnalogue: numeric(record.priceAtAnalogue),
        price1h: numeric(record.price1h),
        price3h: numeric(record.price3h),
        price6h: numeric(record.price6h),
        price1d: numeric(record.price1d),
        price5d: numeric(record.price5d),
        result1h: numeric(record.result1h),
        result3h: numeric(record.result3h),
        result6h: numeric(record.result6h),
        result1d: numeric(record.result1d),
        result5d: numeric(record.result5d),
        direction:
          rawDirection === "LONG" || rawDirection === "SHORT"
            ? rawDirection
            : "нет данных",
      };
    })
    .filter((row): row is StockAnalogMatch => row !== null);
}

function buildStockStats(
  matches: StockAnalogMatch[],
  currentPrices: Map<string, number>,
): StockAnalogStat[] {
  const byTicker = new Map<string, StockAnalogMatch[]>();
  for (const match of matches) {
    const items = byTicker.get(match.ticker) ?? [];
    items.push(match);
    byTicker.set(match.ticker, items);
  }

  return [...byTicker.entries()]
    .map(([ticker, items]) => {
      const results = items
        .map((item) => item.result5d)
        .filter((value): value is number => value !== null && Number.isFinite(value));
      const averageHorizon = (values: Array<number | null>) => {
        const valid = values.filter(
          (value): value is number => value !== null && Number.isFinite(value),
        );
        return valid.length
          ? valid.reduce((sum, value) => sum + value, 0) / valid.length
          : null;
      };
      const upCases = results.filter((value) => value > 0).length;
      const downCases = results.filter((value) => value < 0).length;
      const average5d = results.length
        ? results.reduce((sum, value) => sum + value, 0) / results.length
        : null;
      const upResults = results.filter((value) => value > 0);
      const downResults = results.filter((value) => value < 0);
      const averageUp5d = upResults.length
        ? upResults.reduce((sum, value) => sum + value, 0) / upResults.length
        : null;
      const averageDown5d = downResults.length
        ? downResults.reduce((sum, value) => sum + value, 0) / downResults.length
        : null;
      const stddev5d =
        results.length > 1 && average5d !== null
          ? Math.sqrt(
              results.reduce((sum, value) => sum + (value - average5d) ** 2, 0) /
                results.length,
            )
          : 0;
      const dominantProbability = results.length
        ? Math.max(upCases, downCases) / results.length
        : 0;
      const stability: StockAnalogStat["stability"] =
        results.length >= 10 && dominantProbability >= 0.7 && stddev5d <= 3
          ? "Высокая"
          : results.length >= 8 && dominantProbability >= 0.6
            ? "Средняя"
            : "Низкая";
      return {
        ticker,
        currentPrice: currentPrices.get(ticker) ?? null,
        cases: results.length,
        upCases,
        downCases,
        average1h: averageHorizon(items.map((item) => item.result1h)),
        average3h: averageHorizon(items.map((item) => item.result3h)),
        average6h: averageHorizon(items.map((item) => item.result6h)),
        average5d,
        averageUp5d,
        averageDown5d,
        maxUp5d: results.length ? Math.max(...results) : null,
        maxDown5d: results.length ? Math.min(...results) : null,
        stddev5d,
        stability,
      };
    })
    .sort((left, right) => {
      const leftProbability = left.cases
        ? Math.max(left.upCases, left.downCases) / left.cases
        : 0;
      const rightProbability = right.cases
        ? Math.max(right.upCases, right.downCases) / right.cases
        : 0;
      return rightProbability - leftProbability || Math.abs(right.average5d ?? 0) - Math.abs(left.average5d ?? 0);
    });
}

function scenarioLabel(result: number | null) {
  if (result === null) return "нет данных";
  return result >= 0 ? "LONG" : "SHORT";
}

function signedNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${formatNumber(value, digits)}`;
}

function stockProbability(stock: StockAnalogStat, direction: "LONG" | "SHORT") {
  if (!stock.cases) return null;
  const count = direction === "LONG" ? stock.upCases : stock.downCases;
  return (count / stock.cases) * 100;
}

function formatStockStat(stock: StockAnalogStat) {
  return [
    `${stock.ticker}: текущая цена ${formatNumber(stock.currentPrice)} · аналогов ${stock.cases}`,
    `рост ${stock.upCases}/${stock.cases} · падение ${stock.downCases}/${stock.cases}`,
    `LONG ${formatNumber(stockProbability(stock, "LONG"), 0)}% · SHORT ${formatNumber(stockProbability(stock, "SHORT"), 0)}%`,
    `среднее 5д ${signedNumber(stock.average5d)} · максимум ${signedNumber(stock.maxUp5d)} · минимум ${signedNumber(stock.maxDown5d)}`,
    `стабильность: ${stock.stability}`,
  ].join("\n");
}

function riskPercent(value: number | null, fallback = 0.3) {
  return Math.max(fallback, Math.abs(value ?? 0));
}

function candidateLevels(stock: StockAnalogStat, direction: "LONG" | "SHORT") {
  const entry = stock.currentPrice;
  if (entry === null) {
    return { entry: null, takeProfit: null, stopLoss: null, tpPercent: null, slPercent: null };
  }
  const tpPercent =
    direction === "LONG"
      ? riskPercent(stock.averageUp5d)
      : riskPercent(stock.averageDown5d);
  const slPercent =
    direction === "LONG"
      ? riskPercent(stock.averageDown5d)
      : riskPercent(stock.averageUp5d);
  return {
    entry,
    tpPercent,
    slPercent,
    takeProfit: entry * (1 + (direction === "LONG" ? tpPercent : -tpPercent) / 100),
    stopLoss: entry * (1 + (direction === "LONG" ? -slPercent : slPercent) / 100),
  };
}

function formatCandidate(
  stock: StockAnalogStat,
  direction: "LONG" | "SHORT",
  index: number,
) {
  const levels = candidateLevels(stock, direction);
  return [
    "",
    `${index}. ${stock.ticker} — ${direction}`,
    `Аналогов: ${stock.cases}`,
    `${direction === "LONG" ? "Ростов" : "Падений"}: ${direction === "LONG" ? stock.upCases : stock.downCases}`,
    `Вероятность ${direction}: ${formatNumber(stockProbability(stock, direction), 0)}%`,
    `Среднее движение: ${signedNumber(stock.average5d)}%`,
    `Изменение через 1 час: ${signedNumber(stock.average1h)}%`,
    `Изменение через 3 часа: ${signedNumber(stock.average3h)}%`,
    `Изменение через 6 часов: ${signedNumber(stock.average6h)}%`,
    `Текущая цена / вход: ${formatNumber(levels.entry)}`,
    `Take profit: ${formatNumber(levels.takeProfit)} (${signedNumber(levels.tpPercent)}%)`,
    `Stop loss: ${formatNumber(levels.stopLoss)} (${signedNumber(levels.slPercent)}%)`,
    `Стабильность: ${stock.stability}`,
  ];
}

export async function scanMarketAnalogues(): Promise<string> {
  await ensureSchema();
  const snapshot = await loadCurrentSnapshot();
  if (snapshot.length < MIN_ANALOGS) {
    return "📊 Аналогичные рыночные ситуации\n\nНедостаточно актуальных данных для снимка рынка.";
  }

  const currentDate = new Date(
    Math.max(...snapshot.map((row) => row.timestamp.getTime())),
  );
  const currentImoex = await loadCurrentImoex(currentDate);
  const currentPrices = new Map(snapshot.map((row) => [row.ticker, row.price]));
  await saveSnapshot(snapshot, currentDate);
  const currentVector = marketVector(snapshot);
  const historical = await loadHistoricalVectors(currentDate);
  const ranked = historical
    .map((row) => ({ ...row, similarity: similarity(currentVector, row) }))
    .sort((left, right) => right.similarity - left.similarity);
  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    if (
      selected.every(
        (existing) =>
          Math.abs(existing.timestamp.getTime() - candidate.timestamp.getTime()) >=
          24 * 60 * 60 * 1000,
      )
    ) {
      selected.push(candidate);
    }
    if (selected.length === MAX_ANALOGS) break;
  }
  if (selected.length < MIN_ANALOGS) {
    for (const candidate of ranked) {
      if (!selected.some((existing) => existing.timestamp.getTime() === candidate.timestamp.getTime())) {
        selected.push(candidate);
      }
      if (selected.length === MAX_ANALOGS) break;
    }
  }

  const series = await loadImoexSeries(
    new Date(currentDate.getTime() - (LOOKBACK_DAYS + 2) * 86400000),
    new Date(currentDate.getTime() + HORIZONS.tenDays),
  );
  const matches: AnalogMatch[] = selected.map((candidate) => {
    const before = closestBeforeOrAt(series, candidate.timestamp);
    return {
      historicalDate: candidate.timestamp,
      similarity: candidate.similarity,
      result1h: movement(
        before,
        closestAfterOrAt(series, new Date(candidate.timestamp.getTime() + HORIZONS.oneHour)),
      ),
      result3h: movement(
        before,
        closestAfterOrAt(series, new Date(candidate.timestamp.getTime() + HORIZONS.threeHours)),
      ),
      result6h: movement(
        before,
        closestAfterOrAt(series, new Date(candidate.timestamp.getTime() + HORIZONS.sixHours)),
      ),
      result1d: movement(
        before,
        closestAfterOrAt(series, new Date(candidate.timestamp.getTime() + HORIZONS.oneDay)),
      ),
      result5d: movement(
        before,
        closestAfterOrAt(series, new Date(candidate.timestamp.getTime() + HORIZONS.fiveDays)),
      ),
      result10d: movement(
        before,
        closestAfterOrAt(series, new Date(candidate.timestamp.getTime() + HORIZONS.tenDays)),
      ),
    };
  });
  await saveMatches(currentDate, matches);
  await saveStockMatches(currentDate);
  const stockMatches = await loadStockMatches(currentDate);
  const stockStats = buildStockStats(stockMatches, currentPrices);
  const fiveDayResults = matches
    .map((match) => match.result5d)
    .filter((value): value is number => value !== null);
  const longResults = fiveDayResults.filter((value) => value > 0);
  const shortResults = fiveDayResults.filter((value) => value < 0);
  const longProbability = fiveDayResults.length
    ? (longResults.length / fiveDayResults.length) * 100
    : null;
  const shortProbability = fiveDayResults.length
    ? (shortResults.length / fiveDayResults.length) * 100
    : null;
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const longCandidates = stockStats
    .filter((stock) => stock.upCases > stock.downCases && (stockProbability(stock, "LONG") ?? 0) >= 50)
    .sort(
      (left, right) =>
        (stockProbability(right, "LONG") ?? 0) - (stockProbability(left, "LONG") ?? 0) ||
        (right.average5d ?? -Infinity) - (left.average5d ?? -Infinity),
    )
    .slice(0, 5);
  const shortCandidates = stockStats
    .filter((stock) => stock.downCases > stock.upCases && (stockProbability(stock, "SHORT") ?? 0) >= 50)
    .sort(
      (left, right) =>
        (stockProbability(right, "SHORT") ?? 0) - (stockProbability(left, "SHORT") ?? 0) ||
        (left.average5d ?? Infinity) - (right.average5d ?? Infinity),
    )
    .slice(0, 5);
  const stockMatchesByDate = new Map<number, StockAnalogMatch[]>();
  for (const stockMatch of stockMatches) {
    const items = stockMatchesByDate.get(stockMatch.historicalDate.getTime()) ?? [];
    items.push(stockMatch);
    stockMatchesByDate.set(stockMatch.historicalDate.getTime(), items);
  }
  const detailedAnalogueReport = matches.flatMap((match, index) => {
    const details = stockMatchesByDate.get(match.historicalDate.getTime()) ?? [];
    const detailLines = details.map(
      (stock) =>
        `${stock.ticker}: тогда ${formatNumber(stock.priceAtAnalogue)} · 1ч ${formatNumber(stock.price1h)} (${signedNumber(stock.result1h)}%) · 3ч ${formatNumber(stock.price3h)} (${signedNumber(stock.result3h)}%) · 6ч ${formatNumber(stock.price6h)} (${signedNumber(stock.result6h)}%) · 1д ${formatNumber(stock.price1d)} (${signedNumber(stock.result1d)}%) · 5д ${formatNumber(stock.price5d)} (${signedNumber(stock.result5d)}%) · ${stock.direction}`,
    );
    return [
      "",
      `ИСТОРИЧЕСКИЙ АНАЛОГ ${index + 1}`,
      `Дата: ${formatDate(match.historicalDate)}`,
      `Сходство: ${formatNumber(match.similarity, 0)}%`,
      `Общий сценарий: ${scenarioLabel(match.result5d)}`,
      `IMOEX: 1ч ${signedNumber(match.result1h)}% · 3ч ${signedNumber(match.result3h)}% · 6ч ${signedNumber(match.result6h)}% · 1д ${signedNumber(match.result1d)}% · 5д ${signedNumber(match.result5d)}%`,
      "РАЗБОР 46 АКЦИЙ:",
      ...detailLines,
    ];
  });

  return [
    "📊 АНАЛОГИЧНЫЕ РЫНОЧНЫЕ СИТУАЦИИ",
    "",
    `Снимок рынка: ${snapshot.length} акций`,
    `Актуальные данные: ${formatDate(currentDate)}`,
    `IMOEX сейчас: ${formatNumber(currentImoex?.price)} · данные на ${formatDate(currentImoex?.timestamp ?? currentDate)}`,
    "",
    "ТЕКУЩИЕ ЦЕНЫ АКЦИЙ:",
    ...snapshot.map((row) => `${row.ticker}: ${formatNumber(row.price)}`),
    `Найдено аналогов: ${matches.length}`,
    "",
    "📈 LONG сценарии:",
    `Вероятность: ${formatNumber(longProbability, 0)}%`,
    `Рост: ${longResults.length} случаев`,
    `Среднее движение за 5 дней: ${formatNumber(average(longResults))}%`,
    "",
    "📉 SHORT сценарии:",
    `Вероятность: ${formatNumber(shortProbability, 0)}%`,
    `Падение: ${shortResults.length} случаев`,
    `Среднее движение за 5 дней: ${formatNumber(average(shortResults))}%`,
    "",
    "📊 ИСТОРИЧЕСКИЙ СЦЕНАРИЙ:",
    `Вероятность LONG: ${formatNumber(longProbability, 0)}%`,
    `Средний результат 1 час: ${formatNumber(average(matches.map((match) => match.result1h).filter((value): value is number => value !== null)))}%`,
    `Средний результат 3 часа: ${formatNumber(average(matches.map((match) => match.result3h).filter((value): value is number => value !== null)))}%`,
    `Средний результат 6 часов: ${formatNumber(average(matches.map((match) => match.result6h).filter((value): value is number => value !== null)))}%`,
    `Средний результат 1 день: ${formatNumber(average(matches.map((match) => match.result1d).filter((value): value is number => value !== null)))}%`,
    `Средний потенциал 5 дней: ${formatNumber(average(fiveDayResults))}%`,
    `Среднее падение 5 дней: ${formatNumber(average(shortResults))}%`,
    "",
    "🧾 ПОДРОБНЫЙ РАЗБОР КАЖДОГО АНАЛОГА",
    `Сохранено наблюдений: ${stockMatches.length} (${matches.length} аналогов × ${snapshot.length} акций)`,
    ...detailedAnalogueReport,
    "",
    "📋 СТАТИСТИКА ПО ВСЕМ АКЦИЯМ",
    ...stockStats.flatMap((stock) => ["", formatStockStat(stock)]),
    "",
    "🟢 ЛУЧШИЕ LONG КАНДИДАТЫ:",
    ...(longCandidates.length
      ? longCandidates.flatMap((stock, index) => formatCandidate(stock, "LONG", index + 1))
      : ["нет устойчивых LONG-кандидатов"]),
    "",
    "🔴 ЛУЧШИЕ SHORT КАНДИДАТЫ:",
    ...(shortCandidates.length
      ? shortCandidates.flatMap((stock, index) => formatCandidate(stock, "SHORT", index + 1))
      : ["нет устойчивых SHORT-кандидатов"]),
    "",
    `Вывод: рынок ${shortProbability !== null && longProbability !== null && shortProbability > longProbability ? "слабее, чем в среднем SHORT-сценариях" : "чаще рос в аналогичных условиях"}, но кандидаты отобраны отдельно по статистике каждой акции.`,
  ].join("\n");
}