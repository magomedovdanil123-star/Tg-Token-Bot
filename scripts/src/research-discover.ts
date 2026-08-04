import { sql } from "drizzle-orm";
import {
  db,
  featureCombinations,
  pool,
  strategyResults,
  backtestResults,
} from "@workspace/db";

type Candidate = {
  key: string;
  label: string;
  expression: string;
  direction: "BUY" | "SELL";
};

type DiscoveryRow = {
  condition_key: string;
  condition_label: string;
  direction: "BUY" | "SELL";
  holding_minutes: number;
  occurrences: number;
  success_rate: number;
  average_profit: number;
  average_loss: number;
  expected_value: number;
  profit_factor: number | null;
  sharpe_ratio: number | null;
  max_drawdown: number;
  p_value: number | null;
  confidence_low: number;
  confidence_high: number;
  period_start: string;
  period_end: string;
};

const TIMEFRAME = "10m";
const MIN_OCCURRENCES = 100;
const MAX_RESULTS_PER_RUN = 100;

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function integerArg(name: string, fallback: number) {
  const value = Number(arg(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function makeCandidates(): Candidate[] {
  return [
    {
      key: "rsi_oversold",
      label: "RSI < 30",
      expression: "rsi IS NOT NULL AND rsi < 30",
      direction: "BUY",
    },
    {
      key: "rsi_overbought",
      label: "RSI > 70",
      expression: "rsi IS NOT NULL AND rsi > 70",
      direction: "SELL",
    },
    {
      key: "relative_volume_spike",
      label: "Объём >= 1.5 среднего",
      expression: "relative_volume IS NOT NULL AND relative_volume >= 1.5",
      direction: "BUY",
    },
    {
      key: "ema_bullish",
      label: "EMA20 > EMA50",
      expression: "ema_20 IS NOT NULL AND ema_50 IS NOT NULL AND ema_20 > ema_50",
      direction: "BUY",
    },
    {
      key: "ema_bearish",
      label: "EMA20 < EMA50",
      expression: "ema_20 IS NOT NULL AND ema_50 IS NOT NULL AND ema_20 < ema_50",
      direction: "SELL",
    },
    {
      key: "macd_positive",
      label: "MACD histogram > 0",
      expression: "macd_hist IS NOT NULL AND macd_hist > 0",
      direction: "BUY",
    },
    {
      key: "macd_negative",
      label: "MACD histogram < 0",
      expression: "macd_hist IS NOT NULL AND macd_hist < 0",
      direction: "SELL",
    },
    {
      key: "bb_lower_half",
      label: "Цена ниже средней Bollinger",
      expression: "bb_middle IS NOT NULL AND close < bb_middle",
      direction: "BUY",
    },
    {
      key: "bb_upper_half",
      label: "Цена выше средней Bollinger",
      expression: "bb_middle IS NOT NULL AND close > bb_middle",
      direction: "SELL",
    },
    {
      key: "high_volatility",
      label: "Историческая волатильность >= медианы",
      expression: "historical_volatility IS NOT NULL AND historical_volatility >= volatility_median",
      direction: "BUY",
    },
  ];
}

function compatible(left: Candidate, right: Candidate) {
  return left.direction === right.direction;
}

function combinations(candidates: Candidate[], start = 0, end = candidates.length) {
  const output: { candidates: Candidate[]; direction: "BUY" | "SELL" }[] = [];
  for (let index = start; index < Math.min(end, candidates.length); index += 1) {
    const candidate = candidates[index];
    output.push({ candidates: [candidate], direction: candidate.direction });
  }
  for (let left = start; left < Math.min(end, candidates.length); left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (!compatible(candidates[left], candidates[right])) continue;
      output.push({
        candidates: [candidates[left], candidates[right]],
        direction: candidates[left].direction,
      });
    }
  }
  return output;
}

async function evaluate(
  candidateSet: { candidates: Candidate[]; direction: "BUY" | "SELL" },
  holdingMinutes: number,
) {
  const expression = candidateSet.candidates
    .map((candidate) => candidate.expression)
    .join(" AND ");
  const direction = candidateSet.direction;
  const target = direction === "BUY" ? "future_close > close" : "future_close < close";
  const returnExpression =
    direction === "BUY"
      ? "((future_close - close) / NULLIF(close, 0)) * 100"
      : "((close - future_close) / NULLIF(close, 0)) * 100";
  const bars = Math.max(1, Math.round(holdingMinutes / 10));
  const conditionKey = candidateSet.candidates.map((item) => item.key).join("+");
  const conditionLabel = candidateSet.candidates.map((item) => item.label).join(" + ");

  const result = await db.execute(sql.raw(`
    WITH volatility AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY historical_volatility) AS volatility_median
      FROM features
      WHERE historical_volatility IS NOT NULL
    ),
    base AS MATERIALIZED (
      SELECT
        c.ticker,
        c.timestamp,
        c.close,
        lead(c.close, ${bars}) OVER (
          PARTITION BY c.ticker
          ORDER BY c.timestamp
        ) AS future_close,
        f.rsi,
        f.relative_volume,
        f.ema_20,
        f.ema_50,
        f.macd_hist,
        f.bb_middle,
        f.historical_volatility
      FROM candles c
      INNER JOIN features f
        ON f.ticker = c.ticker
        AND f.timestamp = c.timestamp
      WHERE c.timeframe = '${TIMEFRAME}'
    ),
    matched AS (
      SELECT
        base.*,
        ${returnExpression} AS trade_return,
        CASE WHEN ${target} THEN 1 ELSE 0 END AS is_win
      FROM base
      CROSS JOIN volatility
      WHERE future_close IS NOT NULL
        AND (${expression})
    ),
    stats AS (
      SELECT
        MIN(timestamp) AS period_start,
        MAX(timestamp) AS period_end,
        COUNT(*)::int AS occurrences,
        AVG(is_win::int)::double precision AS success_rate,
        AVG(trade_return) FILTER (WHERE trade_return > 0)::double precision AS average_profit,
        AVG(trade_return) FILTER (WHERE trade_return <= 0)::double precision AS average_loss,
        AVG(trade_return)::double precision AS expected_value,
        CASE
          WHEN SUM(trade_return) FILTER (WHERE trade_return <= 0) = 0 THEN NULL
          ELSE SUM(trade_return) FILTER (WHERE trade_return > 0) /
            ABS(SUM(trade_return) FILTER (WHERE trade_return <= 0))
        END::double precision AS profit_factor,
        STDDEV_SAMP(trade_return)::double precision AS return_stddev,
        MIN(trade_return)::double precision AS worst_return
      FROM matched
    ),
    equity AS (
      SELECT
        timestamp,
        SUM(trade_return) OVER (
          ORDER BY timestamp
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS equity
      FROM matched
    ),
    drawdowns AS (
      SELECT MAX(peak - equity) AS max_drawdown
      FROM (
        SELECT
          equity,
          MAX(equity) OVER (
            ORDER BY timestamp
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS peak
        FROM equity
      ) curve
    )
    SELECT
      '${conditionKey}' AS condition_key,
      '${conditionLabel.replaceAll("'", "''")}' AS condition_label,
      '${direction}'::varchar AS direction,
      ${holdingMinutes}::int AS holding_minutes,
      stats.occurrences,
      stats.success_rate,
      COALESCE(stats.average_profit, 0) AS average_profit,
      COALESCE(stats.average_loss, 0) AS average_loss,
      stats.expected_value,
      stats.profit_factor,
      CASE WHEN stats.return_stddev IS NULL OR stats.return_stddev = 0 THEN NULL
        ELSE stats.expected_value / stats.return_stddev * SQRT(stats.occurrences)
      END AS sharpe_ratio,
      COALESCE((SELECT MAX(max_drawdown) FROM drawdowns), 0) AS max_drawdown,
      EXP(
        -LEAST(
          700,
          0.5 * POWER(
            (stats.success_rate - 0.5) /
            NULLIF(SQRT(0.25 / stats.occurrences), 0),
            2
          )
        )
      ) AS p_value,
      GREATEST(0, stats.success_rate - 1.96 * SQRT(stats.success_rate * (1 - stats.success_rate) / stats.occurrences)) AS confidence_low,
      LEAST(1, stats.success_rate + 1.96 * SQRT(stats.success_rate * (1 - stats.success_rate) / stats.occurrences)) AS confidence_high,
      stats.period_start,
      stats.period_end
    FROM stats
    WHERE stats.occurrences >= ${MIN_OCCURRENCES}
  `));
  return result.rows[0] as DiscoveryRow | undefined;
}

async function evaluateAll(
  candidateSets: { candidates: Candidate[]; direction: "BUY" | "SELL" }[],
  horizons: number[],
) {
  const horizonSpecs = horizons.map((minutes) => ({
    minutes,
    bars: Math.max(1, Math.round(minutes / 10)),
    column: `future_${minutes}`,
  }));
  const maxBars = Math.max(...horizonSpecs.map((item) => item.bars));
  const leadColumns = horizonSpecs
    .map(
      (item) =>
        `lead(c.close, ${item.bars}) OVER (PARTITION BY c.ticker ORDER BY c.timestamp) AS ${item.column}`,
    )
    .join(",\n        ");
  const baseColumns = [
    "c.ticker",
    "c.timestamp",
    "c.close",
    leadColumns,
    "f.rsi",
    "f.relative_volume",
    "f.ema_20",
    "f.ema_50",
    "f.macd_hist",
    "f.bb_middle",
    "f.historical_volatility",
    "(SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY historical_volatility) FROM features WHERE historical_volatility IS NOT NULL) AS volatility_median",
  ].join(",\n        ");
  const tradeQueries = candidateSets.flatMap((candidateSet) =>
    horizonSpecs.map((horizon) => {
      const expression = candidateSet.candidates
        .map((candidate) => candidate.expression)
        .join(" AND ");
      const conditionKey = candidateSet.candidates
        .map((item) => item.key)
        .join("+");
      const conditionLabel = candidateSet.candidates
        .map((item) => item.label)
        .join(" + ")
        .replaceAll("'", "''");
      const direction = candidateSet.direction;
      const returnExpression =
        direction === "BUY"
          ? `((${horizon.column} - close) / NULLIF(close, 0)) * 100`
          : `((close - ${horizon.column}) / NULLIF(close, 0)) * 100`;
      const target =
        direction === "BUY"
          ? `${horizon.column} > close`
          : `${horizon.column} < close`;
      return `
        SELECT
          '${conditionKey}' AS condition_key,
          '${conditionLabel}' AS condition_label,
          '${direction}'::varchar AS direction,
          ${horizon.minutes}::int AS holding_minutes,
          ticker,
          timestamp,
          ${returnExpression} AS trade_return,
          CASE WHEN ${target} THEN 1 ELSE 0 END AS is_win
        FROM base
        WHERE ${horizon.column} IS NOT NULL
          AND (${expression})`;
    }),
  );
  const result = await db.execute(sql.raw(`
    WITH base AS MATERIALIZED (
      SELECT
        ${baseColumns}
      FROM candles c
      INNER JOIN features f
        ON f.ticker = c.ticker
        AND f.timestamp = c.timestamp
      WHERE c.timeframe = '${TIMEFRAME}'
    ),
    trade_rows AS (
      ${tradeQueries.join("\nUNION ALL")}
    ),
    equity AS (
      SELECT
        trade_rows.*,
        SUM(trade_return) OVER (
          PARTITION BY condition_key, holding_minutes
          ORDER BY timestamp
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS equity
      FROM trade_rows
    ),
    peaks AS (
      SELECT
        equity.*,
        MAX(equity) OVER (
          PARTITION BY condition_key, holding_minutes
          ORDER BY timestamp
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS peak
      FROM equity
    ),
    stats AS (
      SELECT
        condition_key,
        condition_label,
        direction,
        holding_minutes,
        MIN(timestamp) AS period_start,
        MAX(timestamp) AS period_end,
        COUNT(*)::int AS occurrences,
        AVG(is_win::int)::double precision AS success_rate,
        AVG(trade_return) FILTER (WHERE trade_return > 0)::double precision AS average_profit,
        AVG(trade_return) FILTER (WHERE trade_return <= 0)::double precision AS average_loss,
        AVG(trade_return)::double precision AS expected_value,
        CASE
          WHEN SUM(trade_return) FILTER (WHERE trade_return <= 0) = 0 THEN NULL
          ELSE SUM(trade_return) FILTER (WHERE trade_return > 0) /
            ABS(SUM(trade_return) FILTER (WHERE trade_return <= 0))
        END::double precision AS profit_factor,
        STDDEV_SAMP(trade_return)::double precision AS return_stddev
      FROM trade_rows
      GROUP BY condition_key, condition_label, direction, holding_minutes
    ),
    drawdowns AS (
      SELECT
        condition_key,
        holding_minutes,
        MAX(peak - equity)::double precision AS max_drawdown
      FROM peaks
      GROUP BY condition_key, holding_minutes
    )
    SELECT
      stats.condition_key,
      stats.condition_label,
      stats.direction,
      stats.holding_minutes,
      stats.occurrences,
      stats.success_rate,
      COALESCE(stats.average_profit, 0) AS average_profit,
      COALESCE(stats.average_loss, 0) AS average_loss,
      stats.expected_value,
      stats.profit_factor,
      CASE WHEN stats.return_stddev IS NULL OR stats.return_stddev = 0 THEN NULL
        ELSE stats.expected_value / stats.return_stddev * SQRT(stats.occurrences)
      END AS sharpe_ratio,
      COALESCE(drawdowns.max_drawdown, 0) AS max_drawdown,
      CASE
        WHEN stats.occurrences = 0 THEN NULL
        WHEN 0.5 * POWER(
          (stats.success_rate - 0.5) /
          NULLIF(SQRT(0.25 / stats.occurrences), 0), 2
        ) > 700 THEN 0
        ELSE EXP(
          -0.5 * POWER(
            (stats.success_rate - 0.5) /
            NULLIF(SQRT(0.25 / stats.occurrences), 0), 2
          )
        )
      END AS p_value,
      GREATEST(0, stats.success_rate - 1.96 * SQRT(stats.success_rate * (1 - stats.success_rate) / stats.occurrences)) AS confidence_low,
      LEAST(1, stats.success_rate + 1.96 * SQRT(stats.success_rate * (1 - stats.success_rate) / stats.occurrences)) AS confidence_high,
      stats.period_start,
      stats.period_end
    FROM stats
    INNER JOIN drawdowns
      ON drawdowns.condition_key = stats.condition_key
      AND drawdowns.holding_minutes = stats.holding_minutes
    WHERE stats.occurrences >= ${MIN_OCCURRENCES}
  `));
  return result.rows as unknown as DiscoveryRow[];
}

async function saveResult(row: DiscoveryRow, conditions: Candidate[]) {
  const conditionJson = conditions.map((condition) => ({
    key: condition.key,
    label: condition.label,
    direction: condition.direction,
  }));
  const name = `auto:${row.condition_key}:${row.holding_minutes}m`;
  const savedCombination = await db
    .insert(featureCombinations)
    .values({
      name,
      conditions: conditionJson,
      occurrences: row.occurrences,
      successRate: row.success_rate,
      averageProfit: row.average_profit,
      averageLoss: row.average_loss,
      expectedValue: row.expected_value,
      profitFactor: row.profit_factor,
      sharpeRatio: row.sharpe_ratio,
      pValue: row.p_value,
      confidenceLow: row.confidence_low,
      confidenceHigh: row.confidence_high,
      maxDrawdown: row.max_drawdown,
      holdingMinutes: row.holding_minutes,
      direction: row.direction,
    })
    .onConflictDoUpdate({
      target: featureCombinations.name,
      set: {
        conditions: conditionJson,
        occurrences: row.occurrences,
        successRate: row.success_rate,
        averageProfit: row.average_profit,
        averageLoss: row.average_loss,
        expectedValue: row.expected_value,
        profitFactor: row.profit_factor,
        sharpeRatio: row.sharpe_ratio,
        pValue: row.p_value,
        confidenceLow: row.confidence_low,
        confidenceHigh: row.confidence_high,
        maxDrawdown: row.max_drawdown,
        holdingMinutes: row.holding_minutes,
        direction: row.direction,
        discoveredAt: new Date(),
        isActive: true,
      },
    })
    .returning({ id: featureCombinations.id });
  const combinationId = savedCombination[0]?.id;
  if (!combinationId) return;

  const strategy = await db
    .insert(strategyResults)
    .values({
      name,
      version: "auto-1",
      conditions: conditionJson,
      winRate: row.success_rate,
      profitFactor: row.profit_factor,
      expectedValue: row.expected_value,
      sharpeRatio: row.sharpe_ratio,
      pValue: row.p_value,
      confidenceLow: row.confidence_low,
      confidenceHigh: row.confidence_high,
      maxDrawdown: row.max_drawdown,
      averageProfit: row.average_profit,
      averageLoss: row.average_loss,
      bestTimeframe: TIMEFRAME,
      tradesCount: row.occurrences,
      metadata: { combinationId, direction: row.direction },
    })
    .onConflictDoUpdate({
      target: [strategyResults.name, strategyResults.version],
      set: {
        conditions: conditionJson,
        winRate: row.success_rate,
        profitFactor: row.profit_factor,
        expectedValue: row.expected_value,
        sharpeRatio: row.sharpe_ratio,
        pValue: row.p_value,
        confidenceLow: row.confidence_low,
        confidenceHigh: row.confidence_high,
        maxDrawdown: row.max_drawdown,
        averageProfit: row.average_profit,
        averageLoss: row.average_loss,
        bestTimeframe: TIMEFRAME,
        tradesCount: row.occurrences,
        evaluatedAt: new Date(),
        metadata: { combinationId, direction: row.direction },
      },
    })
    .returning({ id: strategyResults.id });
  const strategyId = strategy[0]?.id;
  if (!strategyId) return;

  await db
    .insert(backtestResults)
    .values({
      strategyId,
      ticker: null,
      timeframe: TIMEFRAME,
      periodStart: new Date(row.period_start),
      periodEnd: new Date(row.period_end),
      tradesCount: row.occurrences,
      winRate: row.success_rate,
      profitFactor: row.profit_factor,
      expectedValue: row.expected_value,
      sharpeRatio: row.sharpe_ratio,
      pValue: row.p_value,
      confidenceLow: row.confidence_low,
      confidenceHigh: row.confidence_high,
      maxDrawdown: row.max_drawdown,
      averageProfit: row.average_profit,
      averageLoss: row.average_loss,
      netReturn: row.expected_value * row.occurrences,
      metadata: { conditionKey: row.condition_key, holdingMinutes: row.holding_minutes },
    })
    .onConflictDoNothing();
}

async function main() {
  const maxResults = integerArg("max-results", MAX_RESULTS_PER_RUN);
  const candidateLimit = integerArg("candidate-limit", 1000);
  const candidateList = makeCandidates().slice(0, candidateLimit);
  const candidateStart = integerArg("candidate-start", 0) - 1;
  const candidateEnd = integerArg("candidate-end", candidateList.length);
  const allCombinations = combinations(
    candidateList,
    Math.max(0, candidateStart),
    Math.min(candidateList.length, candidateEnd),
  );
  const requestedHorizons = arg("horizons", "15,30,60,240,1440")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const horizons = requestedHorizons.length
    ? requestedHorizons
    : [15, 30, 60, 240, 1440];
  if (allCombinations.length === 0) {
    console.log("Нет комбинаций в указанном диапазоне; пропускаю пакет.");
    await pool.end();
    return;
  }
  console.log(
    `AI Discovery: ${allCombinations.length} комбинаций × ${horizons.length} горизонтов`,
  );
  const discovered = await evaluateAll(allCombinations, horizons);

  discovered.sort(
    (left, right) =>
      (right.expected_value * Math.min(right.success_rate, 1 - right.success_rate + 1)) -
      (left.expected_value * Math.min(left.success_rate, 1 - left.success_rate + 1)),
  );
  const selected = discovered
    .filter((row) => row.success_rate >= 0.52 && row.expected_value > 0)
    .slice(0, maxResults);

  for (const row of selected) {
    const conditions = allCombinations
      .flatMap((item) => item.candidates)
      .filter((candidate) => row.condition_key.split("+").includes(candidate.key));
    await saveResult(row, conditions);
    console.log(
      `${row.condition_key} ${row.direction} ${row.holding_minutes}m: ` +
        `${row.occurrences} случаев, ${(row.success_rate * 100).toFixed(1)}%, ` +
        `EV ${row.expected_value.toFixed(3)}%`,
    );
  }

  await pool.end();
  console.log(
    `Готово. Найдено кандидатов: ${discovered.length}; сохранено закономерностей: ${selected.length}`,
  );
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});