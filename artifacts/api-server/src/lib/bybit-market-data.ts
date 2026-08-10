import { candles, db, moexTickers } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const BYBIT_PUBLIC_API = "https://api.bybit.com/v5/market/kline";
const BYBIT_TICKERS_API = "https://api.bybit.com/v5/market/tickers";
const BYBIT_TOP_LIMIT = 30;
const BYBIT_MARKET_CAP_SYMBOLS = [
  "BTC",
  "ETH",
  "BNB",
  "XRP",
  "SOL",
  "TRX",
  "HYPE",
  "DOGE",
  "LEO",
  "ZEC",
  "XMR",
  "ADA",
  "LINK",
  "XLM",
  "BCH",
  "LTC",
  "HBAR",
  "SUI",
  "AVAX",
  "UNI",
  "TAO",
  "CRO",
  "NEAR",
  "OKB",
  "ONDO",
  "ASTER",
  "WLFI",
  "RLUSD",
  "MNT",
  "CC",
  "GRAM",
  "PAXG",
  "M",
] as const;
const BYBIT_EXCLUDED_SYMBOLS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "USD1",
  "USDE",
  "USDG",
  "USDD",
  "RLUSD",
]);

type BybitResponse = {
  retCode?: number;
  retMsg?: string;
  result?: { list?: string[][] };
};

type BybitTickerResponse = {
  retCode?: number;
  retMsg?: string;
  result?: {
    list?: Array<{
      symbol?: string;
      turnover24h?: string;
    }>;
  };
};

type BybitSymbol = {
  symbol: string;
  name: string;
};

async function getTopBybitSymbols(): Promise<BybitSymbol[]> {
  const url = new URL(BYBIT_TICKERS_API);
  url.searchParams.set("category", "linear");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Bybit tickers returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as BybitTickerResponse;
  if (payload.retCode !== 0 || !payload.result?.list) {
    throw new Error(
      `Bybit tickers returned ${payload.retCode ?? "unknown"}: ${payload.retMsg ?? "unknown error"}`,
    );
  }
  const bybitSymbols = payload.result.list
    .map((ticker) => ({
      symbol: ticker.symbol?.toUpperCase() ?? "",
      turnover: Number(ticker.turnover24h),
    }))
    .filter(
      (ticker) =>
        /^[A-Z0-9]+USDT$/.test(ticker.symbol) &&
        Number.isFinite(ticker.turnover) &&
        ticker.turnover > 0,
    );
  const bybitByBase = new Map(
    bybitSymbols.map((ticker) => [ticker.symbol.slice(0, -4), ticker]),
  );
  const symbols = BYBIT_MARKET_CAP_SYMBOLS
    .filter((base) => !BYBIT_EXCLUDED_SYMBOLS.has(base))
    .map((base) => bybitByBase.get(base))
    .filter((ticker): ticker is { symbol: string; turnover: number } => Boolean(ticker))
    .slice(0, BYBIT_TOP_LIMIT)
    .map(({ symbol }) => ({
      symbol,
      name: `${symbol} · CoinMarketCap top list · Bybit Perpetual`,
    }));
  if (!symbols.length) {
    throw new Error(
      "Bybit has no supported USDT perpetuals from the CoinMarketCap list",
    );
  }
  return symbols;
}

async function loadKlines(symbol: string, interval: "1" | "60") {
  const url = new URL(BYBIT_PUBLIC_API);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", "1000");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Bybit ${symbol}/${interval} returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as BybitResponse;
  if (payload.retCode !== 0 || !payload.result?.list) {
    throw new Error(
      `Bybit ${symbol}/${interval} returned ${payload.retCode ?? "unknown"}: ${payload.retMsg ?? "unknown error"}`,
    );
  }
  return payload.result.list
    .map((row) => {
      const [start, open, high, low, close, volume] = row;
      return {
        ticker: symbol,
        timeframe: interval === "1" ? "1m" : "1h",
        timestamp: new Date(Number(start)),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
        source: "bybit",
      };
    })
    .filter(
      (row) =>
        Number.isFinite(row.timestamp.getTime()) &&
        [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite),
    )
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

export async function refreshBybitMarketData() {
  const symbols = await getTopBybitSymbols();
  await db
    .update(moexTickers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(moexTickers.boardId, "BYBIT"));

  for (const { symbol, name } of symbols) {
    await db
      .insert(moexTickers)
      .values({
        secid: symbol,
        shortName: name,
        rank: null,
        isActive: false,
        boardId: "BYBIT",
      })
      .onConflictDoUpdate({
        target: moexTickers.secid,
        set: {
          shortName: name,
          isActive: true,
          boardId: "BYBIT",
          updatedAt: new Date(),
        },
      });

    const [minuteRows, hourlyRows] = await Promise.all([
      loadKlines(symbol, "1"),
      loadKlines(symbol, "60"),
    ]);
    const rows = [...minuteRows, ...hourlyRows];
    for (let index = 0; index < rows.length; index += 500) {
      await db
        .insert(candles)
        .values(rows.slice(index, index + 500))
        .onConflictDoUpdate({
          target: [
            candles.ticker,
            candles.timeframe,
            candles.timestamp,
            candles.source,
          ],
          set: {
            open: candles.open,
            high: candles.high,
            low: candles.low,
            close: candles.close,
            volume: candles.volume,
            source: "bybit",
          },
        });
    }
  }
}

export async function latestBybitQuotes() {
  const rows = await db
    .select({
      ticker: candles.ticker,
      close: candles.close,
      timestamp: candles.timestamp,
    })
    .from(candles)
    .innerJoin(moexTickers, eq(candles.ticker, moexTickers.secid))
    .where(
      and(
        eq(candles.source, "bybit"),
        eq(candles.timeframe, "1m"),
        eq(moexTickers.boardId, "BYBIT"),
        eq(moexTickers.isActive, true),
      ),
    );
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.ticker) || row.timestamp > latest.get(row.ticker)!.timestamp) {
      latest.set(row.ticker, row);
    }
  }
  return [...latest.values()];
}