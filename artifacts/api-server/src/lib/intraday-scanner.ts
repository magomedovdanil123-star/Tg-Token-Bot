import { desc, eq, sql } from "drizzle-orm";
import { db, moexTickers } from "@workspace/db";

const MOEX_API = "https://iss.moex.com/iss";
const TIMEFRAME = "1m";
const CANDLE_LIMIT = 720;
const MAX_FEATURE_AGE_MINUTES = 30;
const MAX_SPREAD_PERCENT = 0.35;
const MIN_DAY_VALUE_RUBLES = 5_000_000;

type MoexBlock = {
  columns?: string[];
  data?: unknown[][];
};

type MoexPayload = Record<string, MoexBlock>;

type Candle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: number | null;
};

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
  openingRangeBreakout: "up" | "down" | null;
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

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function ema(values: number[], period: number) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period));
  if (current === null) return null;
  for (const value of values.slice(period)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gains = (gains * (period - 1) + Math.max(change, 0)) / period;
    losses = (losses * (period - 1) + Math.max(-change, 0)) / period;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
}

function atr(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.map((candle, index) => {
    const previous = candles[index - 1];
    return previous
      ? Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previous.close),
          Math.abs(candle.low - previous.close),
        )
      : candle.high - candle.low;
  });
  return average(ranges.slice(-period));
}

function adx(candles: Candle[], period = 14) {
  if (candles.length <= period * 2) return null;
  const trueRanges: number[] = [];
  const positiveMoves: number[] = [];
  const negativeMoves: number[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (!previous) {
      trueRanges.push(candle.high - candle.low);
      positiveMoves.push(0);
      negativeMoves.push(0);
      continue;
    }
    const upMove = candle.high - previous.high;
    const downMove = previous.low - candle.low;
    trueRanges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previous.close),
        Math.abs(candle.low - previous.close),
      ),
    );
    positiveMoves.push(upMove > downMove && upMove > 0 ? upMove : 0);
    negativeMoves.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const dx: number[] = [];
  for (let index = period; index < candles.length; index += 1) {
    const tr = average(trueRanges.slice(index - period + 1, index + 1));
    const plus = average(positiveMoves.slice(index - period + 1, index + 1));
    const minus = average(negativeMoves.slice(index - period + 1, index + 1));
    if (tr === null || plus === null || minus === null || tr === 0) continue;
    const plusDi = (plus / tr) * 100;
    const minusDi = (minus / tr) * 100;
    const denominator = plusDi + minusDi;
    if (denominator > 0) dx.push((Math.abs(plusDi - minusDi) / denominator) * 100);
  }
  return dx.length >= period ? average(dx.slice(-period)) : null;
}

function sessionKey(timestamp: Date) {
  return timestamp.toISOString().slice(0, 10);
}

function buildFeatureSnapshot(ticker: string, candles: Candle[]): FeatureSnapshot | null {
  if (candles.length < 60) return null;
  const latest = candles.at(-1);
  if (!latest) return null;
  const closes = candles.map((candle) => candle.close);
  const latestSession = sessionKey(latest.timestamp);
  const sessionCandles = candles.filter((candle) => sessionKey(candle.timestamp) === latestSession);
  const cumulativeVolume = sessionCandles.reduce((sum, candle) => sum + candle.volume, 0);
  const cumulativeValue = sessionCandles.reduce(
    (sum, candle) => sum + (candle.value ?? candle.close * candle.volume),
    0,
  );
  const vwap = cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : null;
  const openingRange = sessionCandles.slice(0, 15);
  const openingHigh = openingRange.length ? Math.max(...openingRange.map((candle) => candle.high)) : null;
  const openingLow = openingRange.length ? Math.min(...openingRange.map((candle) => candle.low)) : null;
  const previousClose = candles.at(-2)?.close ?? null;
  const previousPreviousClose = candles.at(-3)?.close ?? null;
  const currentReturn = previousClose ? ((latest.close - previousClose) / previousClose) * 100 : null;
  const previousReturn =
    previousPreviousClose && previousClose
      ? ((previousClose - previousPreviousClose) / previousPreviousClose) * 100
      : null;
  const volumeWindow = candles.slice(-20).map((candle) => candle.volume);
  const avgVolume20 = average(volumeWindow);

  return {
    ticker,
    timestamp: latest.timestamp,
    close: latest.close,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    vwap,
    relativeVolume: avgVolume20 ? latest.volume / avgVolume20 : null,
    rsi: rsi(closes),
    adx: adx(candles),
    atr: atr(candles),
    bbWidth: (() => {
      const window = closes.slice(-20);
      const middle = average(window);
      if (middle === null || middle === 0) return null;
      const deviation = Math.sqrt(
        average(window.map((value) => (value - middle) ** 2)) ?? 0,
      );
      return (deviation * 4) / middle * 100;
    })(),
    priceChange3:
      candles.at(-4)?.close
        ? ((latest.close - candles.at(-4)!.close) / candles.at(-4)!.close) * 100
        : null,
    acceleration:
      currentReturn !== null && previousReturn !== null ? currentReturn - previousReturn : null,
    volume: latest.volume,
    avgVolume20,
    openingRangeBreakout:
      openingHigh !== null && latest.close > openingHigh
        ? "up"
        : openingLow !== null && latest.close < openingLow
          ? "down"
          : null,
  };
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

async function getLatestIntradayFeatures() {
  const result = await db.execute(sql`
    SELECT t.secid AS ticker, c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.value
    FROM moex_tickers t
    CROSS JOIN LATERAL (
      SELECT timestamp, open, high, low, close, volume, value
      FROM candles
      WHERE ticker = t.secid
        AND timeframe = ${TIMEFRAME}
      ORDER BY timestamp DESC
      LIMIT ${CANDLE_LIMIT}
    ) c
    WHERE t.is_active = true
      AND t.secid <> 'IMOEX'
    ORDER BY t.secid, c.timestamp
  `);
  const grouped = new Map<string, Candle[]>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const timestamp = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
    const candle: Candle = {
      timestamp,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume) || 0,
      value: numberValue(row.value),
    };
    if (!Number.isFinite(timestamp.getTime()) || !Number.isFinite(candle.close)) continue;
    const ticker = String(row.ticker);
    const rows = grouped.get(ticker) ?? [];
    rows.push(candle);
    grouped.set(ticker, rows);
  }
  return new Map(
    [...grouped.entries()]
      .map(([ticker, rows]) => [ticker, buildFeatureSnapshot(ticker, rows)] as const)
      .filter((entry): entry is readonly [string, FeatureSnapshot] => Boolean(entry[1])),
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
  if (
    feature.openingRangeBreakout !== null &&
    ((direction === "BUY" && feature.openingRangeBreakout === "up") ||
      (direction === "SELL" && feature.openingRangeBreakout === "down"))
  ) {
    score += 8;
    reasons.push(
      feature.openingRangeBreakout === "up"
        ? "пробой максимума Opening Range"
        : "пробой минимума Opening Range",
    );
  }
  if (feature.rsi !== null) {
    reasons.push(`RSI ${feature.rsi.toFixed(1)}`);
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
    getLatestIntradayFeatures(),
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