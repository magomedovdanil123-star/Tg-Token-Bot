import { sql } from "drizzle-orm";
import {
  assetCorrelations,
  db,
  marketLevels,
  pool,
} from "@workspace/db";

const TIMEFRAME = "10m";
const WINDOWS = [20, 50, 200];

type LevelRow = {
  ticker: string;
  close: number;
  support_20: number | null;
  resistance_20: number | null;
  support_50: number | null;
  resistance_50: number | null;
  support_200: number | null;
  resistance_200: number | null;
};

type CorrelationRow = {
  asset_ticker: string;
  benchmark_ticker: string;
  window_bars: number;
  correlation: number | null;
  sample_count: number;
  period_start: string | null;
  period_end: string | null;
};

async function refreshLevels() {
  const result = await db.execute(sql.raw(`
    WITH ranked AS (
      SELECT
        ticker,
        timestamp,
        close,
        MIN(low) OVER (
          PARTITION BY ticker ORDER BY timestamp
          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
        ) AS support_20,
        MAX(high) OVER (
          PARTITION BY ticker ORDER BY timestamp
          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
        ) AS resistance_20,
        MIN(low) OVER (
          PARTITION BY ticker ORDER BY timestamp
          ROWS BETWEEN 49 PRECEDING AND CURRENT ROW
        ) AS support_50,
        MAX(high) OVER (
          PARTITION BY ticker ORDER BY timestamp
          ROWS BETWEEN 49 PRECEDING AND CURRENT ROW
        ) AS resistance_50,
        MIN(low) OVER (
          PARTITION BY ticker ORDER BY timestamp
          ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
        ) AS support_200,
        MAX(high) OVER (
          PARTITION BY ticker ORDER BY timestamp
          ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
        ) AS resistance_200,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS row_number
      FROM candles
      WHERE timeframe = '${TIMEFRAME}'
    )
    SELECT
      ticker, close,
      support_20, resistance_20,
      support_50, resistance_50,
      support_200, resistance_200
    FROM ranked
    WHERE row_number = 1
  `));

  for (const row of result.rows as unknown as LevelRow[]) {
    const levels = [
      { type: "support", window: 20, price: row.support_20 },
      { type: "resistance", window: 20, price: row.resistance_20 },
      { type: "support", window: 50, price: row.support_50 },
      { type: "resistance", window: 50, price: row.resistance_50 },
      { type: "support", window: 200, price: row.support_200 },
      { type: "resistance", window: 200, price: row.resistance_200 },
    ];
    for (const level of levels) {
      if (level.price === null || level.price === undefined) continue;
      const distance = Math.abs(row.close - level.price) / row.close;
      await db
        .insert(marketLevels)
        .values({
          ticker: row.ticker,
          timeframe: TIMEFRAME,
          levelType: level.type,
          windowBars: level.window,
          price: level.price,
          strength: 1 / Math.max(distance, 0.0001),
          touches: 0,
          calculatedAt: new Date(),
          metadata: { source: "rolling-high-low", close: row.close },
        })
        .onConflictDoUpdate({
          target: [
            marketLevels.ticker,
            marketLevels.timeframe,
            marketLevels.levelType,
            marketLevels.windowBars,
          ],
          set: {
            price: level.price,
            strength: 1 / Math.max(distance, 0.0001),
            calculatedAt: new Date(),
            metadata: { source: "rolling-high-low", close: row.close },
          },
        });
    }
  }
  return (result.rows as unknown[]).length;
}

async function refreshCorrelations() {
  const result = await db.execute(sql.raw(`
    WITH returns AS MATERIALIZED (
      SELECT
        ticker,
        timestamp,
        LN(close / NULLIF(LAG(close) OVER (
          PARTITION BY ticker ORDER BY timestamp
        ), 0)) AS asset_return
      FROM candles
      WHERE timeframe = '${TIMEFRAME}'
        AND close > 0
    ),
    aligned AS (
      SELECT
        asset.ticker AS asset_ticker,
        benchmark.ticker AS benchmark_ticker,
        asset.timestamp,
        asset.asset_return,
        benchmark.asset_return AS benchmark_return
      FROM returns asset
      INNER JOIN returns benchmark
        ON benchmark.ticker = 'IMOEX'
        AND benchmark.timestamp = asset.timestamp
      WHERE asset.ticker <> 'IMOEX'
        AND asset.asset_return IS NOT NULL
        AND benchmark.asset_return IS NOT NULL
    ),
    latest AS (
      SELECT
        asset_ticker,
        benchmark_ticker,
        COUNT(*)::int AS sample_count,
        CORR(asset_return, benchmark_return)::double precision AS correlation,
        MIN(timestamp) AS period_start,
        MAX(timestamp) AS period_end
      FROM aligned
      GROUP BY asset_ticker, benchmark_ticker
    )
    SELECT
      asset_ticker,
      benchmark_ticker,
      200::int AS window_bars,
      correlation,
      sample_count,
      period_start,
      period_end
    FROM latest
    WHERE sample_count >= 200
  `));

  for (const row of result.rows as unknown as CorrelationRow[]) {
    await db
      .insert(assetCorrelations)
      .values({
        assetTicker: row.asset_ticker,
        benchmarkTicker: row.benchmark_ticker,
        timeframe: TIMEFRAME,
        windowBars: row.window_bars,
        correlation: row.correlation,
        sampleCount: row.sample_count,
        periodStart: row.period_start ? new Date(row.period_start) : null,
        periodEnd: row.period_end ? new Date(row.period_end) : null,
        calculatedAt: new Date(),
        metadata: { source: "aligned-log-returns" },
      })
      .onConflictDoUpdate({
        target: [
          assetCorrelations.assetTicker,
          assetCorrelations.benchmarkTicker,
          assetCorrelations.timeframe,
          assetCorrelations.windowBars,
        ],
        set: {
          correlation: row.correlation,
          sampleCount: row.sample_count,
          periodStart: row.period_start ? new Date(row.period_start) : null,
          periodEnd: row.period_end ? new Date(row.period_end) : null,
          calculatedAt: new Date(),
        },
      });
  }
  return (result.rows as unknown[]).length;
}

async function main() {
  const [levels, correlations] = await Promise.all([
    refreshLevels(),
    refreshCorrelations(),
  ]);
  console.log(`Уровни обновлены для ${levels} тикеров; корреляции IMOEX: ${correlations}`);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});