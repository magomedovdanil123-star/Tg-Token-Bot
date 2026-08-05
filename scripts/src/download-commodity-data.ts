import { candles, db, moexTickers, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    } | null>;
    error?: { description?: string | null } | null;
  };
};

type CommoditySpec = {
  ticker: string;
  yahooSymbol: string;
  name: string;
};

const COMMODITIES: CommoditySpec[] = [
  { ticker: "XAUUSD", yahooSymbol: "GC=F", name: "Золото · Gold Futures" },
  { ticker: "XAGUSD", yahooSymbol: "SI=F", name: "Серебро · Silver Futures" },
  { ticker: "BRENT", yahooSymbol: "BZ=F", name: "Нефть Brent · Brent Crude Futures" },
];

const PAGE_TIMEFRAMES = new Set(
  (process.argv.find((item) => item.startsWith("--timeframes="))?.split("=")[1] ??
    "1m")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value === "1m" || value === "1h" || value === "1d"),
);

const RANGE_BY_TIMEFRAME: Record<string, string> = {
  "1m": "2d",
  "1h": "2y",
  "1d": "5y",
};

const INTERVAL_BY_TIMEFRAME: Record<string, string> = {
  "1m": "1m",
  "1h": "1h",
  "1d": "1d",
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function yahooUrl(symbol: string, timeframe: string) {
  const params = new URLSearchParams({
    interval: INTERVAL_BY_TIMEFRAME[timeframe],
    range: RANGE_BY_TIMEFRAME[timeframe],
    events: "history",
    includePrePost: "true",
  });
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
}

async function fetchChart(symbol: string, timeframe: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(yahooUrl(symbol, timeframe), {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 InvestAI/1.0",
        },
      });
      if (response.ok) return (await response.json()) as YahooChartResponse;
      lastError = new Error(`Yahoo Finance HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Yahoo Finance request failed for ${symbol}`);
}

async function loadRows(spec: CommoditySpec, timeframe: string) {
  const payload = await fetchChart(spec.yahooSymbol, timeframe);
  const result = payload.chart?.result?.[0];
  if (!result) {
    throw new Error(
      payload.chart?.error?.description ??
        `Yahoo Finance returned no data for ${spec.yahooSymbol}`,
    );
  }
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  if (!quote) return [];
  return timestamps
    .map((timestamp, index) => {
      const open = quote.open?.[index];
      const high = quote.high?.[index];
      const low = quote.low?.[index];
      const close = quote.close?.[index];
      const volume = quote.volume?.[index];
      if (
        !finite(timestamp) ||
        !finite(open) ||
        !finite(high) ||
        !finite(low) ||
        !finite(close)
      ) {
        return null;
      }
      return {
        ticker: spec.ticker,
        timeframe,
        timestamp: new Date(timestamp * 1000),
        open,
        high,
        low,
        close,
        volume: finite(volume) ? volume : 0,
        source: "yahoo_finance",
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

async function saveSpec(spec: CommoditySpec) {
  await db
    .insert(moexTickers)
    .values({
      secid: spec.ticker,
      shortName: spec.name,
      rank: null,
      isActive: false,
      boardId: "GLOBAL",
    })
    .onConflictDoUpdate({
      target: moexTickers.secid,
      set: {
        shortName: spec.name,
        isActive: false,
        boardId: "GLOBAL",
        updatedAt: new Date(),
      },
    });

  let total = 0;
  for (const timeframe of PAGE_TIMEFRAMES) {
    const rows = await loadRows(spec, timeframe);
    for (let index = 0; index < rows.length; index += 500) {
      const batch = rows.slice(index, index + 500);
      await db
        .insert(candles)
        .values(batch)
        .onConflictDoUpdate({
          target: [candles.ticker, candles.timeframe, candles.timestamp],
          set: {
            open: sql.raw('excluded."open"'),
            high: sql.raw('excluded."high"'),
            low: sql.raw('excluded."low"'),
            close: sql.raw('excluded."close"'),
            volume: sql.raw('excluded."volume"'),
            source: sql.raw('excluded."source"'),
          },
        });
    }
    total += rows.length;
    console.log(`${spec.ticker} ${timeframe}: ${rows.length} свечей`);
  }
  return total;
}

async function main() {
  if (!PAGE_TIMEFRAMES.size) {
    throw new Error("Нужен хотя бы один timeframe: 1m, 1h или 1d");
  }
  let total = 0;
  for (const spec of COMMODITIES) {
    total += await saveSpec(spec);
  }
  console.log(
    `Сырьевые данные обновлены: ${COMMODITIES.length} инструментов, ${total} свечей`,
  );
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});