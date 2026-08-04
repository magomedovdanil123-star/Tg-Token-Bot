import { sql } from "drizzle-orm";
import { db, patterns, pool } from "@workspace/db";

const TIMEFRAME = "10m";
const MIN_OCCURRENCES = 30;

type PatternSummary = {
  ticker: string;
  pattern_name: string;
  direction: "BUY" | "SELL";
  occurrences: number;
  success_rate: number;
  profit_factor: number | null;
  average_profit: number | null;
};

function eventCtes() {
  return `
    WITH base AS MATERIALIZED (
      SELECT
        c.ticker,
        c.timestamp,
        c.close,
        f.is_doji,
        f.is_hammer,
        f.is_engulfing,
        f.is_inside_bar,
        f.is_outside_bar,
        lead(c.close, 2) OVER (PARTITION BY c.ticker ORDER BY c.timestamp) AS future_15,
        lead(c.close, 3) OVER (PARTITION BY c.ticker ORDER BY c.timestamp) AS future_30,
        lead(c.close, 6) OVER (PARTITION BY c.ticker ORDER BY c.timestamp) AS future_1h,
        lead(c.close, 24) OVER (PARTITION BY c.ticker ORDER BY c.timestamp) AS future_4h,
        lead(c.close, 144) OVER (PARTITION BY c.ticker ORDER BY c.timestamp) AS future_1d
      FROM candles c
      INNER JOIN features f
        ON f.ticker = c.ticker
        AND f.timestamp = c.timestamp
      WHERE c.timeframe = '${TIMEFRAME}'
    ),
    events AS (
      SELECT ticker, timestamp, close, 'Doji' AS pattern_name,
        ((future_15 - close) / NULLIF(close, 0)) * 100 AS result_15m,
        ((future_30 - close) / NULLIF(close, 0)) * 100 AS result_30m,
        ((future_1h - close) / NULLIF(close, 0)) * 100 AS result_1h,
        ((future_4h - close) / NULLIF(close, 0)) * 100 AS result_4h,
        ((future_1d - close) / NULLIF(close, 0)) * 100 AS result_1d
      FROM base WHERE is_doji = 1
      UNION ALL
      SELECT ticker, timestamp, close, 'Hammer',
        ((future_15 - close) / NULLIF(close, 0)) * 100,
        ((future_30 - close) / NULLIF(close, 0)) * 100,
        ((future_1h - close) / NULLIF(close, 0)) * 100,
        ((future_4h - close) / NULLIF(close, 0)) * 100,
        ((future_1d - close) / NULLIF(close, 0)) * 100
      FROM base WHERE is_hammer = 1
      UNION ALL
      SELECT ticker, timestamp, close, 'Engulfing',
        ((future_15 - close) / NULLIF(close, 0)) * 100,
        ((future_30 - close) / NULLIF(close, 0)) * 100,
        ((future_1h - close) / NULLIF(close, 0)) * 100,
        ((future_4h - close) / NULLIF(close, 0)) * 100,
        ((future_1d - close) / NULLIF(close, 0)) * 100
      FROM base WHERE is_engulfing = 1
      UNION ALL
      SELECT ticker, timestamp, close, 'Inside Bar',
        ((future_15 - close) / NULLIF(close, 0)) * 100,
        ((future_30 - close) / NULLIF(close, 0)) * 100,
        ((future_1h - close) / NULLIF(close, 0)) * 100,
        ((future_4h - close) / NULLIF(close, 0)) * 100,
        ((future_1d - close) / NULLIF(close, 0)) * 100
      FROM base WHERE is_inside_bar = 1
      UNION ALL
      SELECT ticker, timestamp, close, 'Outside Bar',
        ((future_15 - close) / NULLIF(close, 0)) * 100,
        ((future_30 - close) / NULLIF(close, 0)) * 100,
        ((future_1h - close) / NULLIF(close, 0)) * 100,
        ((future_4h - close) / NULLIF(close, 0)) * 100,
        ((future_1d - close) / NULLIF(close, 0)) * 100
      FROM base WHERE is_outside_bar = 1
    )`;
}

function patternQuery() {
  return `
    ${eventCtes()},
    directional AS (
      SELECT
        ticker,
        pattern_name,
        CASE WHEN AVG(result_1h) >= 0 THEN 'BUY' ELSE 'SELL' END AS direction,
        COUNT(*)::int AS occurrences,
        CASE
          WHEN AVG(result_1h) >= 0 THEN AVG(CASE WHEN result_1h > 0 THEN 1.0 ELSE 0.0 END)
          ELSE AVG(CASE WHEN result_1h < 0 THEN 1.0 ELSE 0.0 END)
        END AS success_rate,
        CASE
          WHEN SUM(result_1h) FILTER (WHERE result_1h < 0) = 0 THEN NULL
          ELSE SUM(result_1h) FILTER (WHERE result_1h > 0) /
            ABS(SUM(result_1h) FILTER (WHERE result_1h < 0))
        END AS profit_factor,
        CASE WHEN AVG(result_1h) >= 0
          THEN AVG(result_1h) FILTER (WHERE result_1h > 0)
          ELSE AVG(result_1h) FILTER (WHERE result_1h < 0)
        END AS average_profit
      FROM events
      WHERE result_1h IS NOT NULL
      GROUP BY ticker, pattern_name
      HAVING COUNT(*) >= ${MIN_OCCURRENCES}
    )
    SELECT * FROM directional;
  `;
}

async function main() {
  const summaries = await db.execute(sql.raw(patternQuery()));
  const rows = summaries.rows as unknown as PatternSummary[];
  let saved = 0;

  for (const row of rows) {
    await db
      .insert(patterns)
      .values({
        ticker: row.ticker,
        name: row.pattern_name,
        timeframe: TIMEFRAME,
        direction: row.direction,
        occurrences: row.occurrences,
        successRate: row.success_rate,
        profitFactor: row.profit_factor,
        averageProfit: row.average_profit,
        isActive: true,
        discoveredAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          patterns.ticker,
          patterns.name,
          patterns.timeframe,
          patterns.direction,
        ],
        set: {
          occurrences: row.occurrences,
          successRate: row.success_rate,
          profitFactor: row.profit_factor,
          averageProfit: row.average_profit,
          discoveredAt: new Date(),
          isActive: true,
        },
      });
    saved += 1;
  }

  await db.execute(sql.raw(`
    ${eventCtes()}
    INSERT INTO pattern_occurrences (
      pattern_id, ticker, timeframe, timestamp, entry_price, direction,
      result_15m, result_30m, result_1h, result_4h, result_1d, metadata
    )
    SELECT
      p.id,
      events.ticker,
      '${TIMEFRAME}',
      events.timestamp,
      events.close,
      CASE WHEN events.result_1h >= 0 THEN 'BUY' ELSE 'SELL' END,
      events.result_15m,
      events.result_30m,
      events.result_1h,
      events.result_4h,
      events.result_1d,
      jsonb_build_object('source', 'candle-pattern-discovery')
    FROM events
    INNER JOIN patterns p
      ON p.ticker = events.ticker
      AND p.name = events.pattern_name
      AND p.timeframe = '${TIMEFRAME}'
      AND p.direction = CASE WHEN events.result_1h >= 0 THEN 'BUY' ELSE 'SELL' END
    WHERE events.result_1h IS NOT NULL
    ON CONFLICT DO NOTHING;
  `));

  console.log(
    `Свечные паттерны: рассчитано ${rows.length}, сохранено ${saved}; исходы записаны в pattern_occurrences`,
  );
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});