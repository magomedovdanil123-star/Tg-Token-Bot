import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const TIMEFRAME = "10m";
const MAX_ANALOGS = 15;
const MIN_ANALOGS = 5;
const LOOKBACK_DAYS = 365;
const HORIZONS = {
  oneHour: 60 * 60 * 1000,
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
  result1d: number | null;
  result5d: number | null;
  result10d: number | null;
};

type CandlePoint = { timestamp: Date; close: number };

type StockAnalogStat = {
  ticker: string;
  cases: number;
  upCases: number;
  average5d: number | null;
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
      market_result_1d DOUBLE PRECISION,
      market_result_5d DOUBLE PRECISION,
      market_result_10d DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS analog_matches_current_history_uq
      ON analog_matches (snapshot_date, historical_date)
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
  for (const match of matches) {
    await db.execute(sql`
      INSERT INTO analog_matches (
        snapshot_date, historical_date, similarity_score,
        market_result_1h, market_result_1d, market_result_5d, market_result_10d
      )
      VALUES (
        ${currentDate}, ${match.historicalDate}, ${match.similarity},
        ${match.result1h}, ${match.result1d}, ${match.result5d}, ${match.result10d}
      )
      ON CONFLICT (snapshot_date, historical_date) DO UPDATE SET
        similarity_score = EXCLUDED.similarity_score,
        market_result_1h = EXCLUDED.market_result_1h,
        market_result_1d = EXCLUDED.market_result_1d,
        market_result_5d = EXCLUDED.market_result_5d,
        market_result_10d = EXCLUDED.market_result_10d
    `);
  }
}

async function loadStockStats(currentDate: Date): Promise<StockAnalogStat[]> {
  const result = await db.execute(sql`
    WITH analogs AS (
      SELECT historical_date
      FROM analog_matches
      WHERE snapshot_date = ${currentDate}
    )
    SELECT
      t.secid AS ticker,
      COUNT(future.close)::int AS cases,
      COUNT(*) FILTER (WHERE future.close > historical.close)::int AS "upCases",
      AVG((future.close / NULLIF(historical.close, 0) - 1) * 100) AS "average5d"
    FROM moex_tickers t
    CROSS JOIN analogs a
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
        AND c.timestamp >= a.historical_date + INTERVAL '5 days'
      ORDER BY c.timestamp
      LIMIT 1
    ) future ON true
    WHERE t.is_active = true AND t.secid <> 'IMOEX'
    GROUP BY t.secid
    HAVING COUNT(future.close) >= 5
    ORDER BY (COUNT(*) FILTER (WHERE future.close > historical.close)::double precision /
      NULLIF(COUNT(future.close), 0)) DESC, AVG((future.close / NULLIF(historical.close, 0) - 1) * 100) DESC
    LIMIT 5
  `);
  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      ticker: String(record.ticker),
      cases: Math.round(numeric(record.cases) ?? 0),
      upCases: Math.round(numeric(record.upCases) ?? 0),
      average5d: numeric(record.average5d),
    };
  });
}

function scenarioLabel(result: number | null) {
  if (result === null) return "нет данных";
  return result >= 0 ? "LONG" : "SHORT";
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
  const stockStats = await loadStockStats(currentDate);
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

  return [
    "📊 АНАЛОГИЧНЫЕ РЫНОЧНЫЕ СИТУАЦИИ",
    "",
    `Снимок рынка: ${snapshot.length} акций`,
    `Дата: ${formatDate(currentDate)}`,
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
    `Средний результат 1 день: ${formatNumber(average(matches.map((match) => match.result1d).filter((value): value is number => value !== null)))}%`,
    `Средний потенциал 5 дней: ${formatNumber(average(fiveDayResults))}%`,
    `Среднее падение 5 дней: ${formatNumber(average(shortResults))}%`,
    "",
    "Похожие сценарии:",
    ...matches.map(
      (match, index) =>
        `${index + 1}. ${formatDate(match.historicalDate)} · сходство ${formatNumber(match.similarity, 0)}% · ${scenarioLabel(match.result5d)} · 1ч ${formatNumber(match.result1h)}% · 1д ${formatNumber(match.result1d)}% · 5д ${formatNumber(match.result5d)}%`,
    ),
    "",
    "Лучшие акции по этим аналогам:",
    ...stockStats.map(
      (stock, index) =>
        `${index + 1}. ${stock.ticker}: ${stock.upCases}/${stock.cases} рост · среднее 5д ${formatNumber(stock.average5d)}%`,
    ),
    "",
    "Вывод: направление выбрано по большинству 5-дневных исходов аналогичных рыночных ситуаций.",
  ].join("\n");
}