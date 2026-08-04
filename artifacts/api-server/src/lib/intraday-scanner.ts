import { desc, eq, sql } from "drizzle-orm";
import { candles, db, features, moexTickers } from "@workspace/db";

const MOEX_API = "https://iss.moex.com/iss";
const TIMEFRAME = "10m";
const MAX_FEATURE_AGE_MINUTES = 30;
const MAX_SPREAD_PERCENT = 0.35;
const MIN_DAY_VALUE_RUBLES = 5_000_000;

type MoexBlock = {
  columns?: string[];
  data?: unknown[][];
};

type MoexPayload = Record<string, MoexBlock>;

type Quote = {
  ticker: string;
  last: number | null;
  open: number | null;
  bid: number | null;
  offer: number | null;
  spread: number | null;
  trades: number | null;
  volume: number | null;
  value: number | null;
  lastChange: number | null;
};

type FeatureSnapshot = {
  ticker: string;
  timestamp: Date;
  close: number;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  relativeVolume: number | null;
  rsi: number | null;
  adx: number | null;
  atr: number | null;
  bbWidth: number | null;
  priceChange3: number | null;
  acceleration: number | null;
  volume: number | null;
  avgVolume20: number | null;
};

export type IntradayCandidate = {
  ticker: string;
  direction: "BUY" | "SELL";
  score: number;
  quote: Quote;
  feature: FeatureSnapshot;
  spreadPercent: number | null;
  currentChangePercent: number | null;
  distanceToVwapPercent: number | null;
  targetPercent: number;
  stopPercent: number;
  reasons: string[];
};

export type IntradayScan = {
  generatedAt: Date;
  analyzed: number;
  freshFeatures: number;
  candidates: IntradayCandidate[];
  unavailable: string[];
  orderBookStatus: "not_available";
};

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowsFromBlock(block: MoexBlock | undefined) {
  if (!block?.columns || !block.data) return [] as Record<string, unknown>[];
  return block.data.map((values) =>
    Object.fromEntries(block.columns!.map((column, index) => [column, values[index]])),
  );
}

async function fetchMoex(path: string, params: Record<string, string>) {
  const url = new URL(`${MOEX_API}${path}`);
  url.searchParams.set("iss.meta", "off");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "InvestAI/1.0" },
  });
  if (!response.ok) throw new Error(`MOEX HTTP ${response.status}`);
  const payload = (await response.json()) as MoexPayload;
  if (!payload.marketdata) throw new Error("MOEX marketdata block is missing");
  return rowsFromBlock(payload.marketdata);
}

async function fetchQuotes(tickers: string[]) {
  const rows = await fetchMoex(
    "/engines/stock/markets/shares/boards/TQBR/securities.json",
    {
      "iss.only": "marketdata",
      "marketdata.columns":
        "SECID,LAST,OPEN,BID,OFFER,SPREAD,NUMTRADES,VOLTODAY,VALTODAY,LASTCHANGE",
      securities: tickers.join(","),
    },
  );
  return new Map<string, Quote>(
    rows.map((row) => [
      String(row.SECID),
      {
        ticker: String(row.SECID),
        last: numberValue(row.LAST),
        open: numberValue(row.OPEN),
        bid: numberValue(row.BID),
        offer: numberValue(row.OFFER),
        spread: numberValue(row.SPREAD),
        trades: numberValue(row.NUMTRADES),
        volume: numberValue(row.VOLTODAY),
        value: numberValue(row.VALTODAY),
        lastChange: numberValue(row.LASTCHANGE),
      },
    ]),
  );
}

async function getLatestFeatures() {
  const result = await db.execute(sql`
    SELECT
      t.secid AS ticker,
      f.timestamp,
      c.close,
      f.ema_20 AS "ema20",
      f.ema_50 AS "ema50",
      f.vwap,
      f.relative_volume AS "relativeVolume",
      f.rsi,
      f.adx,
      f.atr,
      f.bb_width AS "bbWidth",
      f.price_change_3 AS "priceChange3",
      f.acceleration,
      f.volume,
      f.avg_volume_20 AS "avgVolume20"
    FROM moex_tickers t
    CROSS JOIN LATERAL (
      SELECT *
      FROM features f
      WHERE f.ticker = t.secid
      ORDER BY f.timestamp DESC
      LIMIT 1
    ) f
    INNER JOIN candles c ON c.id = f.candle_id
      AND c.timeframe = ${TIMEFRAME}
    WHERE t.is_active = true
      AND t.secid <> 'IMOEX'
  `);
  return new Map<string, FeatureSnapshot>(
    result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return [
        String(row.ticker),
        {
          ticker: String(row.ticker),
          timestamp:
            row.timestamp instanceof Date
              ? row.timestamp
              : new Date(String(row.timestamp)),
          close: Number(row.close),
          ema20: numberValue(row.ema20),
          ema50: numberValue(row.ema50),
          vwap: numberValue(row.vwap),
          relativeVolume: numberValue(row.relativeVolume),
          rsi: numberValue(row.rsi),
          adx: numberValue(row.adx),
          atr: numberValue(row.atr),
          bbWidth: numberValue(row.bbWidth),
          priceChange3: numberValue(row.priceChange3),
          acceleration: numberValue(row.acceleration),
          volume: numberValue(row.volume),
          avgVolume20: numberValue(row.avgVolume20),
        },
      ];
    }),
  );
}

function ageMinutes(timestamp: Date, now: Date) {
  return Math.max(0, (now.getTime() - timestamp.getTime()) / 60_000);
}

function percentChange(current: number, base: number) {
  return base !== 0 ? ((current - base) / base) * 100 : null;
}

function buildCandidate(quote: Quote, feature: FeatureSnapshot): IntradayCandidate | null {
  if (quote.last === null || quote.bid === null || quote.offer === null) return null;
  if (feature.close <= 0) return null;
  const spreadPercent =
    quote.spread !== null
      ? (quote.spread / quote.last) * 100
      : ((quote.offer - quote.bid) / quote.last) * 100;
  if (!Number.isFinite(spreadPercent) || spreadPercent > MAX_SPREAD_PERCENT) return null;
  if (quote.value !== null && quote.value < MIN_DAY_VALUE_RUBLES) return null;

  const currentChangePercent = percentChange(quote.last, feature.close);
  const distanceToVwapPercent =
    feature.vwap !== null ? percentChange(quote.last, feature.vwap) : null;
  const bullishSignals = [
    feature.vwap !== null && quote.last > feature.vwap,
    feature.ema20 !== null && quote.last > feature.ema20,
    feature.ema50 !== null && quote.last > feature.ema50,
    currentChangePercent !== null && currentChangePercent > 0.05,
    feature.priceChange3 !== null && feature.priceChange3 > 0,
    feature.acceleration !== null && feature.acceleration > 0,
  ].filter(Boolean).length;
  const bearishSignals = [
    feature.vwap !== null && quote.last < feature.vwap,
    feature.ema20 !== null && quote.last < feature.ema20,
    feature.ema50 !== null && quote.last < feature.ema50,
    currentChangePercent !== null && currentChangePercent < -0.05,
    feature.priceChange3 !== null && feature.priceChange3 < 0,
    feature.acceleration !== null && feature.acceleration < 0,
  ].filter(Boolean).length;
  const direction = bullishSignals >= bearishSignals ? "BUY" : "SELL";
  const directionalSignals = Math.max(bullishSignals, bearishSignals);
  if (directionalSignals < 4) return null;

  let score = 48 + directionalSignals * 6;
  const reasons: string[] = [];
  if (feature.vwap !== null && (direction === "BUY" ? quote.last > feature.vwap : quote.last < feature.vwap)) {
    score += 8;
    reasons.push(direction === "BUY" ? "цена выше VWAP" : "цена ниже VWAP");
  }
  if (feature.ema20 !== null && feature.ema50 !== null) {
    const aligned = direction === "BUY" ? feature.ema20 > feature.ema50 : feature.ema20 < feature.ema50;
    if (aligned) {
      score += 7;
      reasons.push("EMA20 и EMA50 направлены в сторону сигнала");
    }
  }
  if (feature.relativeVolume !== null && feature.relativeVolume >= 1.2) {
    score += 7;
    reasons.push(`относительный объём ${feature.relativeVolume.toFixed(2)}x`);
  }
  if (feature.adx !== null && feature.adx >= 20) {
    score += 5;
    reasons.push(`ADX ${feature.adx.toFixed(1)} подтверждает движение`);
  }
  if (currentChangePercent !== null) {
    reasons.push(`текущая цена изменилась на ${currentChangePercent >= 0 ? "+" : ""}${currentChangePercent.toFixed(2)}% от последней свечи`);
  }
  reasons.push(`спред ${spreadPercent.toFixed(3)}%`);
  if (quote.value !== null) reasons.push(`оборот сегодня ${Math.round(quote.value).toLocaleString("ru-RU")} ₽`);

  const boundedScore = Math.min(95, Math.round(score));
  const targetPercent = 0.6;
  const stopPercent = 0.3;
  return {
    ticker: quote.ticker,
    direction,
    score: boundedScore,
    quote,
    feature,
    spreadPercent,
    currentChangePercent,
    distanceToVwapPercent,
    targetPercent,
    stopPercent,
    reasons,
  };
}

export async function scanIntraday(): Promise<IntradayScan> {
  const generatedAt = new Date();
  const tickerRows = await db
    .select({ ticker: moexTickers.secid })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(desc(moexTickers.rank));
  const tickers = tickerRows.map((row) => row.ticker).filter((ticker) => ticker !== "IMOEX");
  const [quotes, latestFeatures] = await Promise.all([
    fetchQuotes(tickers),
    getLatestFeatures(),
  ]);
  const unavailable: string[] = [];
  let freshFeatures = 0;
  const candidates: IntradayCandidate[] = [];
  for (const ticker of tickers) {
    const quote = quotes.get(ticker);
    const feature = latestFeatures.get(ticker);
    if (!quote || quote.last === null) {
      unavailable.push(`${ticker}: нет текущей котировки`);
      continue;
    }
    if (!feature || ageMinutes(feature.timestamp, generatedAt) > MAX_FEATURE_AGE_MINUTES) {
      unavailable.push(`${ticker}: индикаторы старше ${MAX_FEATURE_AGE_MINUTES} минут`);
      continue;
    }
    freshFeatures += 1;
    const candidate = buildCandidate(quote, feature);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((left, right) => right.score - left.score);
  return {
    generatedAt,
    analyzed: tickers.length,
    freshFeatures,
    candidates: candidates.slice(0, 5),
    unavailable,
    orderBookStatus: "not_available",
  };
}