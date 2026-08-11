import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  candles,
  db,
  downloadRuns,
  features,
  marketContext,
  moexTickers,
  pool,
  SMART_MONEY_TICKERS,
} from "@workspace/db";

type JsonBlock = { columns?: string[]; data?: unknown[][] };
type MoexResponse = Record<string, JsonBlock | undefined>;
type CandleRow = {
  ticker: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value?: number | null;
};

function parseMoexTimestamp(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return new Date(Number.NaN);
  // MOEX returns candle timestamps without an offset, in Europe/Moscow time.
  // The API server runs in UTC, so parsing the raw string directly shifts
  // every intraday candle three hours into the future.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(?:\.\d+)?)?$/.test(text)) {
    return new Date(`${text.replace(" ", "T")}+03:00`);
  }
  return new Date(text);
}

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const API_ROOT = "https://iss.moex.com/iss";
const TIMEFRAME = arg("timeframe", "10m");
const INTERVAL_BY_TIMEFRAME: Record<string, number> = {
  "1m": 1,
  "10m": 10,
  "30m": 30,
  "1h": 60,
  "1d": 24,
};
const INTERVAL = INTERVAL_BY_TIMEFRAME[TIMEFRAME];
if (!INTERVAL) {
  throw new Error(`Неподдерживаемый timeframe: ${TIMEFRAME}. Доступны 1m, 10m, 30m, 1h и 1d.`);
}
const IS_FEATURE_TIMEFRAME = TIMEFRAME === "10m";
const IS_RAW_ONLY_TIMEFRAME = !IS_FEATURE_TIMEFRAME;
const PAGE_SIZE = 500;
const REQUEST_DELAY_MS = 120;
const LOOKBACK_DAYS = Math.max(1, Number(arg("days", "5")) || 5);
const MARKET_CONTEXT_MAX_GAP_MS = {
  "1m": 15 * 60 * 1000,
  "1h": 90 * 60 * 1000,
} as const;
const SECOND_TIER_TICKER_NAMES: Record<string, string> = {
  ABIO: "Артген",
  AKRN: "Акрон",
  APTK: "Аптеки36и6",
  BAZA: "Базис",
  BTBR: "В2В-РТС",
  DATA: "Аренадата",
  DELI: "Делимобиль",
  DIAS: "Диасофт",
  ETLN: "Эталон",
  FESH: "ДВМП",
  GLRX: "ГЛОРАКС",
  HNFG: "ХЭНДЕРСОН",
  IVAT: "ИВА",
  KMAZ: "КАМАЗ",
  MRKC: "Россети Центр",
  MRKP: "Россети Центр и Приволжье",
  MRKU: "Россети Урал",
  MRKV: "Россети Волга",
  MRKZ: "Россети Северо-Запад",
  MSRS: "Россети Сибирь",
  OGKB: "ОГК-2",
  PRMD: "Промомед",
  RASP: "Распадская",
  SNGS: "Сургутнефтегаз",
  SNGSP: "Сургутнефтегаз-п",
  SOFL: "Софтлайн",
  SVAV: "СОЛЛЕРС",
  TGKN: "ТГК-14",
  TRMK: "ТМК",
  UGLD: "Южуралзолото",
  VSMO: "ВСМПО-АВИСМА",
  WUSH: "ВУШ Холдинг",
  OZON: "Озон",
  OZPH: "Озон Фармацевтика",
};

const SMART_MONEY_TICKER_ROWS = SMART_MONEY_TICKERS.map((secid) => ({
  secid,
  shortName: SECOND_TIER_TICKER_NAMES[secid] ?? secid,
}));

function integerArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function booleanArg(name: string, fallback = false): boolean {
  return arg(name, String(fallback)) === "true";
}

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function blockRows(response: MoexResponse, key: string): Record<string, unknown>[] {
  const block = response[key];
  if (!block?.columns || !block.data) return [];
  return block.data.map((row) =>
    Object.fromEntries(block.columns!.map((column, index) => [column.toLowerCase(), row[index]])),
  );
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMoex(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<MoexResponse> {
  const url = new URL(`${API_ROOT}${path}`);
  url.searchParams.set("iss.meta", "off");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "InvestAI/1.0" },
      });
      if (response.ok) return (await response.json()) as MoexResponse;
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`MOEX HTTP ${response.status} for ${url.pathname}`);
      }
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await sleep(500 * attempt);
  }
  throw new Error(`MOEX request failed: ${path}`);
}

async function getIMOEXTickers() {
  const response = await fetchMoex(
    "/statistics/engines/stock/markets/index/analytics/IMOEX.json",
    {
      limit: 1000,
    },
  );
  const rows = blockRows(response, "analytics");
  const unique = new Map<
    string,
    {
      secid: string;
      shortName: string | null;
      weight: number;
    }
  >();
  for (const row of rows) {
    const secid = String(row.secids ?? row.ticker ?? "").trim();
    if (!secid || secid === "null" || secid === "IMOEX") continue;
    const weight = numeric(row.weight) ?? 0;
    if (!unique.has(secid)) {
      unique.set(secid, {
        secid,
        shortName: row.shortnames ? String(row.shortnames) : null,
        weight,
      });
    }
  }
  return [...unique.values()]
    .sort((left, right) => right.weight - left.weight)
    .map((row) => ({
      secid: row.secid,
      shortName: row.shortName,
      capitalization: undefined,
    }));
}

async function getCandles(
  ticker: string,
  start: string,
  till: string,
  engine: "stock" | "index" = "stock",
  market: "shares" | "index" = "shares",
  board = "TQBR",
): Promise<CandleRow[]> {
  const result: CandleRow[] = [];
  for (let startIndex = 0; ; startIndex += PAGE_SIZE) {
    const response = await fetchMoex(
      `/engines/${engine}/markets/${market}/boards/${board}/securities/${encodeURIComponent(ticker)}/candles.json`,
      { interval: INTERVAL, from: start, till, start: startIndex, limit: PAGE_SIZE },
    );
    const rows = blockRows(response, "candles");
    if (rows.length === 0) break;

    for (const row of rows) {
      const timestamp = parseMoexTimestamp(row.begin ?? row.end);
      const open = numeric(row.open);
      const high = numeric(row.high);
      const low = numeric(row.low);
      const close = numeric(row.close);
      if (
        Number.isNaN(timestamp.getTime()) ||
        open === undefined ||
        high === undefined ||
        low === undefined ||
        close === undefined
      ) {
        continue;
      }
      result.push({
        ticker,
        timestamp,
        open,
        high,
        low,
        close,
        volume: numeric(row.volume) ?? 0,
        value: numeric(row.value),
      });
    }
    if (rows.length < PAGE_SIZE) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return result;
}

async function getAggregated30mCandles(
  ticker: string,
  start: string,
  till: string,
): Promise<CandleRow[]> {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${till}T23:59:59.999Z`);
  const rows = await db
    .select({
      timestamp: candles.timestamp,
      open: candles.open,
      high: candles.high,
      low: candles.low,
      close: candles.close,
      volume: candles.volume,
      value: candles.value,
    })
    .from(candles)
    .where(
      and(
        eq(candles.ticker, ticker),
        eq(candles.timeframe, "10m"),
        gte(candles.timestamp, startDate),
        lte(candles.timestamp, endDate),
      ),
    )
    .orderBy(asc(candles.timestamp));

  const buckets = new Map<number, CandleRow>();
  for (const row of rows) {
    const bucketMs = Math.floor(row.timestamp.getTime() / (30 * 60_000)) * 30 * 60_000;
    const current = buckets.get(bucketMs);
    if (!current) {
      buckets.set(bucketMs, {
        ticker,
        timestamp: new Date(bucketMs),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        value: row.value,
      });
      continue;
    }
    current.high = Math.max(current.high, row.high);
    current.low = Math.min(current.low, row.low);
    current.close = row.close;
    current.volume += row.volume;
    current.value =
      current.value == null || row.value == null
        ? current.value ?? row.value ?? undefined
        : current.value + row.value;
  }
  return [...buckets.values()].sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
  );
}

async function loadTimeframeCandles(
  ticker: string,
  start: string,
  till: string,
  engine: "stock" | "index" = "stock",
  market: "shares" | "index" = "shares",
  board = "TQBR",
) {
  const direct = await getCandles(ticker, start, till, engine, market, board);
  if (TIMEFRAME !== "30m" || direct.length > 0) return direct;
  const aggregated = await getAggregated30mCandles(ticker, start, till);
  if (aggregated.length > 0) {
    console.log(`${ticker}: 30m построен агрегацией из сохранённых 10m (${aggregated.length} свечей)`);
  }
  return aggregated;
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function ema(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period))!;
  for (const value of values.slice(period)) current = (value - current) * multiplier + current;
  return current;
}

function emaSeries(values: number[], period: number): (number | undefined)[] {
  const output: (number | undefined)[] = Array.from({ length: values.length });
  if (values.length < period) return output;
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period))!;
  output[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

function rsi(values: number[], period = 14): number | undefined {
  if (values.length <= period) return undefined;
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
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function rsiSeries(values: number[], period = 14): (number | undefined)[] {
  const output: (number | undefined)[] = Array.from({ length: values.length });
  if (values.length <= period) return output;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  output[period] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gains = (gains * (period - 1) + Math.max(change, 0)) / period;
    losses = (losses * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }
  return output;
}

function adxSeries(
  rows: { high: number; low: number; close: number }[],
  period = 14,
): (number | undefined)[] {
  const output: (number | undefined)[] = Array.from({ length: rows.length });
  if (rows.length <= period * 2) return output;

  const trueRanges: number[] = [];
  const positiveMoves: number[] = [];
  const negativeMoves: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    if (!previous) {
      trueRanges.push(rows[index].high - rows[index].low);
      positiveMoves.push(0);
      negativeMoves.push(0);
      continue;
    }
    const upMove = rows[index].high - previous.high;
    const downMove = previous.low - rows[index].low;
    trueRanges.push(
      Math.max(
        rows[index].high - rows[index].low,
        Math.abs(rows[index].high - previous.close),
        Math.abs(rows[index].low - previous.close),
      ),
    );
    positiveMoves.push(upMove > downMove && upMove > 0 ? upMove : 0);
    negativeMoves.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const dx: (number | undefined)[] = Array.from({ length: rows.length });
  for (let index = period; index < rows.length; index += 1) {
    const tr = average(trueRanges.slice(index - period + 1, index + 1));
    const plus = average(positiveMoves.slice(index - period + 1, index + 1));
    const minus = average(negativeMoves.slice(index - period + 1, index + 1));
    if (!tr || plus === undefined || minus === undefined) continue;
    const plusDi = (plus / tr) * 100;
    const minusDi = (minus / tr) * 100;
    const denominator = plusDi + minusDi;
    dx[index] = denominator ? (Math.abs(plusDi - minusDi) / denominator) * 100 : 0;
  }
  for (let index = period * 2 - 1; index < rows.length; index += 1) {
    const values = dx
      .slice(index - period + 1, index + 1)
      .filter((value): value is number => value !== undefined);
    if (values.length === period) output[index] = average(values);
  }
  return output;
}

function featureRows(rows: (CandleRow & { id: number })[]) {
  const closes = rows.map((row) => row.close);
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema100Series = emaSeries(closes, 100);
  const ema200Series = emaSeries(closes, 200);
  const ema12Series = emaSeries(closes, 12);
  const ema26Series = emaSeries(closes, 26);
  const macdSeries = closes.map((_close, index) => {
    if (ema12Series[index] === undefined || ema26Series[index] === undefined) {
      return undefined;
    }
    return ema12Series[index]! - ema26Series[index]!;
  });
  const macdValues = macdSeries.filter((value): value is number => value !== undefined);
  const macdSignalValues = emaSeries(macdValues, 9);
  const macdSignalSeries: (number | undefined)[] = Array.from({ length: rows.length });
  let signalIndex = 0;
  for (let index = 0; index < macdSeries.length; index += 1) {
    if (macdSeries[index] !== undefined) {
      macdSignalSeries[index] = macdSignalValues[signalIndex];
      signalIndex += 1;
    }
  }
  const rsiValues = rsiSeries(closes);
  const adxValues = adxSeries(rows);
  const output = [];
  let greenStreak = 0;
  let redStreak = 0;
  let cumulativeValue = 0;
  let cumulativeVolume = 0;
  let obv = 0;
  let accumulationDistribution = 0;

  const standardDeviation = (values: number[]) => {
    if (values.length < 2) return undefined;
    const mean = average(values);
    if (mean === undefined) return undefined;
    return Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (values.length - 1),
    );
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    const range = Math.max(row.high - row.low, 0);
    const body = Math.abs(row.close - row.open);
    const window20 = rows.slice(Math.max(0, index - 19), index + 1);
    const highs = rows.slice(Math.max(0, index - 199), index + 1).map((item) => item.high);
    const lows = rows.slice(Math.max(0, index - 199), index + 1).map((item) => item.low);
    const volumeAverage = average(window20.map((item) => item.volume));
    const macd = macdSeries[index];
    const macdSignal = macdSignalSeries[index];
    const middle = average(window20.map((item) => item.close));
    const deviation = middle === undefined
      ? undefined
      : Math.sqrt(average(window20.map((item) => (item.close - middle) ** 2)) ?? 0);
    const previousRange = previous ? Math.max(previous.high - previous.low, 0) : undefined;
    const priorClose = previous?.close ?? row.open;
    const trueRange = Math.max(row.high - row.low, Math.abs(row.high - priorClose), Math.abs(row.low - priorClose));
    cumulativeValue += (row.value ?? row.close * row.volume);
    cumulativeVolume += row.volume;
    if (previous) {
      if (row.close > previous.close) obv += row.volume;
      else if (row.close < previous.close) obv -= row.volume;
    }
    accumulationDistribution += range
      ? ((2 * row.close - row.high - row.low) / range) * row.volume
      : 0;

    if (row.close >= row.open) {
      greenStreak += 1;
      redStreak = 0;
    } else {
      redStreak += 1;
      greenStreak = 0;
    }

    const returns = (period: number) => {
      const base = rows[index - period]?.close;
      return base ? ((row.close - base) / base) * 100 : undefined;
    };
    const rsiWindow = rsiValues
      .slice(Math.max(0, index - 13), index + 1)
      .filter((value): value is number => value !== undefined);
    const currentRsi = rsiValues[index];
    const rsiLow = rsiWindow.length ? Math.min(...rsiWindow) : undefined;
    const rsiHigh = rsiWindow.length ? Math.max(...rsiWindow) : undefined;
    const stochasticRsi =
      currentRsi !== undefined &&
      rsiLow !== undefined &&
      rsiHigh !== undefined &&
      rsiHigh !== rsiLow
        ? ((currentRsi - rsiLow) / (rsiHigh - rsiLow)) * 100
        : undefined;
    const typicalPrice = (row.high + row.low + row.close) / 3;
    const typicalWindow = rows
      .slice(Math.max(0, index - 19), index + 1)
      .map((item) => (item.high + item.low + item.close) / 3);
    const typicalAverage = average(typicalWindow);
    const meanDeviation = typicalAverage === undefined
      ? undefined
      : average(typicalWindow.map((value) => Math.abs(value - typicalAverage)));
    const cci =
      typicalAverage !== undefined &&
      meanDeviation !== undefined &&
      meanDeviation !== 0
        ? (typicalPrice - typicalAverage) / (0.015 * meanDeviation)
        : undefined;
    const oscillatorWindow = rows.slice(Math.max(0, index - 13), index + 1);
    const oscillatorHigh = oscillatorWindow.length
      ? Math.max(...oscillatorWindow.map((item) => item.high))
      : undefined;
    const oscillatorLow = oscillatorWindow.length
      ? Math.min(...oscillatorWindow.map((item) => item.low))
      : undefined;
    const williamsR =
      oscillatorHigh !== undefined &&
      oscillatorLow !== undefined &&
      oscillatorHigh !== oscillatorLow
        ? ((oscillatorHigh - row.close) / (oscillatorHigh - oscillatorLow)) * -100
        : undefined;
    const logReturns = rows
      .slice(Math.max(1, index - 19), index + 1)
      .map((item, windowIndex) => {
        const base = rows[Math.max(0, index - 19) + windowIndex - 1]?.close;
        return base && item.close > 0 ? Math.log(item.close / base) : undefined;
      })
      .filter((value): value is number => value !== undefined);
    const historicalVolatility = standardDeviation(logReturns);
    const previousEma20 = ema20Series[index - 1];
    const currentEma20 = ema20Series[index];
    const previousEma50 = ema50Series[index - 1];
    const currentEma50 = ema50Series[index];
    const emaCross =
      previousEma20 !== undefined &&
      currentEma20 !== undefined &&
      previousEma50 !== undefined &&
      currentEma50 !== undefined
        ? previousEma20 <= previousEma50 && currentEma20 > currentEma50
          ? "golden_cross"
          : previousEma20 >= previousEma50 && currentEma20 < currentEma50
            ? "death_cross"
            : undefined
        : undefined;

    output.push({
      candleId: row.id,
      ticker: row.ticker,
      timestamp: row.timestamp,
      priceChange1: returns(1),
      priceChange3: returns(3),
      priceChange5: returns(5),
      priceChange10: returns(10),
      priceChange15: returns(15),
      priceChange30: returns(30),
      priceChange60: returns(60),
      acceleration: previous?.close && returns(1) !== undefined
        ? returns(1)! - ((previous.close - (rows[index - 2]?.close ?? previous.open)) / previous.close) * 100
        : undefined,
      distanceToHigh: highs.length ? ((row.close - Math.max(...highs)) / row.close) * 100 : undefined,
      distanceToLow: lows.length ? ((row.close - Math.min(...lows)) / row.close) * 100 : undefined,
      bodySize: body,
      upperShadow: row.high - Math.max(row.open, row.close),
      lowerShadow: Math.min(row.open, row.close) - row.low,
      bodyToRange: range ? body / range : 0,
      greenStreak,
      redStreak,
      isDoji: range > 0 && body / range < 0.1 ? 1 : 0,
      isHammer: range > 0 && (Math.min(row.open, row.close) - row.low) > body * 2 ? 1 : 0,
      isEngulfing: previous && row.open <= previous.close && row.close >= previous.open ? 1 : 0,
      isInsideBar: previous && row.high <= previous.high && row.low >= previous.low ? 1 : 0,
      isOutsideBar: previous && row.high >= previous.high && row.low <= previous.low ? 1 : 0,
      volume: row.volume,
      avgVolume20: volumeAverage,
      relativeVolume: volumeAverage ? row.volume / volumeAverage : undefined,
      volumeSpike: volumeAverage && row.volume > volumeAverage * 2 ? 1 : 0,
      atr: trueRange,
      candleRange: range,
      volatilityChange: previousRange ? ((range - previousRange) / previousRange) * 100 : undefined,
      ema20: ema20Series[index],
      ema50: ema50Series[index],
      ema100: ema100Series[index],
      ema200: ema200Series[index],
      distanceToEma20: ema20Series[index]
        ? ((row.close - ema20Series[index]!) / ema20Series[index]!) * 100
        : undefined,
      distanceToEma50: ema50Series[index]
        ? ((row.close - ema50Series[index]!) / ema50Series[index]!) * 100
        : undefined,
      distanceToEma100: ema100Series[index]
        ? ((row.close - ema100Series[index]!) / ema100Series[index]!) * 100
        : undefined,
      distanceToEma200: ema200Series[index]
        ? ((row.close - ema200Series[index]!) / ema200Series[index]!) * 100
        : undefined,
      emaCross,
      trendStrength:
        currentEma20 !== undefined && currentEma50 !== undefined
          ? (Math.abs(currentEma20 - currentEma50) / row.close) * 100
          : undefined,
      rsi: currentRsi,
      macd,
      macdSignal,
      macdHist:
        macd === undefined || macdSignal === undefined
          ? undefined
          : macd - macdSignal,
      bbUpper: middle === undefined || deviation === undefined ? undefined : middle + deviation * 2,
      bbMiddle: middle,
      bbLower: middle === undefined || deviation === undefined ? undefined : middle - deviation * 2,
      bbWidth:
        middle === undefined || deviation === undefined || middle === 0
          ? undefined
          : (deviation * 4) / middle,
      adx: adxValues[index],
      historicalVolatility:
        historicalVolatility === undefined
          ? undefined
          : historicalVolatility * Math.sqrt(252) * 100,
      stochasticRsi,
      cci,
      williamsR,
      vwap: cumulativeVolume ? cumulativeValue / cumulativeVolume : undefined,
      obv,
      mfi: (() => {
        const flowWindow = rows.slice(Math.max(0, index - 13), index + 1);
        let positive = 0;
        let negative = 0;
        for (let flowIndex = 0; flowIndex < flowWindow.length; flowIndex += 1) {
          const flowRow = flowWindow[flowIndex];
          const flowTypical = (flowRow.high + flowRow.low + flowRow.close) / 3;
          const priorFlowRow = flowWindow[flowIndex - 1];
          const moneyFlow = flowTypical * flowRow.volume;
          if (!priorFlowRow || flowTypical >= (priorFlowRow.high + priorFlowRow.low + priorFlowRow.close) / 3) {
            positive += moneyFlow;
          } else {
            negative += moneyFlow;
          }
        }
        return negative === 0 ? (positive ? 100 : undefined) : 100 - 100 / (1 + positive / negative);
      })(),
      accumulationDistribution,
      volumeProfile: { [row.close.toFixed(2)]: row.volume },
    });
  }
  return output;
}

async function saveCandles(rows: CandleRow[]) {
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (let index = 0; index < rows.length; index += 500) {
    const batch = rows.slice(index, index + 500);
    const saved = await db
      .insert(candles)
      .values(
        batch.map((row) => ({
          ...row,
          timeframe: TIMEFRAME,
          source: "moex_iss",
        })),
      )
      .onConflictDoUpdate({
        target: [
          candles.ticker,
          candles.timeframe,
          candles.timestamp,
          candles.source,
        ],
        set: {
          open: sql.raw('excluded."open"'),
          high: sql.raw('excluded."high"'),
          low: sql.raw('excluded."low"'),
          close: sql.raw('excluded."close"'),
          volume: sql.raw('excluded."volume"'),
          value: sql.raw('excluded."value"'),
        },
      })
      .returning({ id: candles.id });
    inserted += saved.length;
  }
  return inserted;
}

async function upsertCalculatedFeatures(calculated: ReturnType<typeof featureRows>) {
  if (!calculated.length) return 0;
  const excluded = (column: string) => sql.raw(`excluded."${column}"`);
  let inserted = 0;
  for (let index = 0; index < calculated.length; index += 500) {
    const saved = await db
      .insert(features)
      .values(calculated.slice(index, index + 500))
      .onConflictDoUpdate({
        target: [features.ticker, features.timestamp],
        set: {
          candleId: excluded("candle_id"),
          priceChange1: excluded("price_change_1"),
          priceChange3: excluded("price_change_3"),
          priceChange5: excluded("price_change_5"),
          priceChange10: excluded("price_change_10"),
          priceChange15: excluded("price_change_15"),
          priceChange30: excluded("price_change_30"),
          priceChange60: excluded("price_change_60"),
          acceleration: excluded("acceleration"),
          distanceToHigh: excluded("distance_to_high"),
          distanceToLow: excluded("distance_to_low"),
          bodySize: excluded("body_size"),
          upperShadow: excluded("upper_shadow"),
          lowerShadow: excluded("lower_shadow"),
          bodyToRange: excluded("body_to_range"),
          greenStreak: excluded("green_streak"),
          redStreak: excluded("red_streak"),
          isDoji: excluded("is_doji"),
          isHammer: excluded("is_hammer"),
          isEngulfing: excluded("is_engulfing"),
          isInsideBar: excluded("is_inside_bar"),
          isOutsideBar: excluded("is_outside_bar"),
          volume: excluded("volume"),
          avgVolume20: excluded("avg_volume_20"),
          relativeVolume: excluded("relative_volume"),
          volumeSpike: excluded("volume_spike"),
          atr: excluded("atr"),
          candleRange: excluded("candle_range"),
          volatilityChange: excluded("volatility_change"),
          ema20: excluded("ema_20"),
          ema50: excluded("ema_50"),
          ema100: excluded("ema_100"),
          ema200: excluded("ema_200"),
          distanceToEma20: excluded("distance_to_ema_20"),
          distanceToEma50: excluded("distance_to_ema_50"),
          distanceToEma100: excluded("distance_to_ema_100"),
          distanceToEma200: excluded("distance_to_ema_200"),
          emaCross: excluded("ema_cross"),
          trendStrength: excluded("trend_strength"),
          rsi: excluded("rsi"),
          macd: excluded("macd"),
          macdSignal: excluded("macd_signal"),
          macdHist: excluded("macd_hist"),
          stochasticRsi: excluded("stochastic_rsi"),
          cci: excluded("cci"),
          williamsR: excluded("williams_r"),
          bbUpper: excluded("bb_upper"),
          bbMiddle: excluded("bb_middle"),
          bbLower: excluded("bb_lower"),
          bbWidth: excluded("bb_width"),
          adx: excluded("adx"),
          historicalVolatility: excluded("historical_volatility"),
          vwap: excluded("vwap"),
          obv: excluded("obv"),
          mfi: excluded("mfi"),
          accumulationDistribution: excluded("accumulation_distribution"),
          volumeProfile: excluded("volume_profile"),
        },
      })
      .returning({ id: features.id });
    inserted += saved.length;
  }
  return inserted;
}

async function calculateFeatures(ticker: string) {
  const rows = await db
    .select()
    .from(candles)
    .where(and(eq(candles.ticker, ticker), eq(candles.timeframe, TIMEFRAME)))
    .orderBy(asc(candles.timestamp));
  if (rows.length < 2) return 0;

  return upsertCalculatedFeatures(featureRows(rows));
}

async function calculateLatestFeature(ticker: string) {
  const rows = await db
    .select()
    .from(candles)
    .where(and(eq(candles.ticker, ticker), eq(candles.timeframe, TIMEFRAME)))
    .orderBy(desc(candles.timestamp))
    .limit(260);
  if (rows.length < 2) return 0;
  rows.reverse();
  const calculated = featureRows(rows);
  return upsertCalculatedFeatures(calculated.slice(-1));
}

async function saveTicker(
  ticker: {
    secid: string;
    shortName: string | null;
    securityType?: string | null;
    capitalization?: number;
  },
  rank: number,
  active = true,
) {
  await db
    .insert(moexTickers)
    .values({
      secid: ticker.secid,
      shortName: ticker.shortName,
      capitalization: ticker.capitalization,
      rank,
    })
    .onConflictDoUpdate({
      target: moexTickers.secid,
      set: {
        shortName: ticker.shortName,
        capitalization: ticker.capitalization,
        rank,
        isActive: active,
        updatedAt: new Date(),
      },
    });
}

async function main() {
  if (arg("sync-index-only", "false") === "true") {
    const tickers = await getIMOEXTickers();
    if (tickers.length === 0) {
      throw new Error("MOEX вернул пустой состав IMOEX; база не изменена");
    }
    await db.update(moexTickers).set({ isActive: false });
    for (let index = 0; index < tickers.length; index += 1) {
      await saveTicker(tickers[index], index + 1);
    }
    console.log(`Состав IMOEX синхронизирован: ${tickers.length} акций`);
    console.log(tickers.map((ticker) => ticker.secid).join(", "));
    await pool.end();
    return;
  }

  if (arg("features-only", "false") === "true") {
    if (!IS_FEATURE_TIMEFRAME) {
      throw new Error(`Для timeframe=${TIMEFRAME} расчёт общей таблицы features отключён`);
    }
    const featuresStart = integerArg("features-start", 0);
    const featuresLimit = integerArg("features-limit", 1000);
    const requestedTicker = arg("ticker", "").trim().toUpperCase();
    const missingAdxOnly = arg("missing-adx-only", "false") === "true";
    const tickerRows = (
      await db
        .selectDistinct({ ticker: candles.ticker })
        .from(candles)
        .innerJoin(moexTickers, eq(moexTickers.secid, candles.ticker))
        .where(
          requestedTicker
            ? and(
                eq(moexTickers.isActive, true),
                eq(candles.ticker, requestedTicker),
              )
            : eq(moexTickers.isActive, true),
        )
        .orderBy(asc(candles.ticker))
    ).slice(featuresStart, featuresStart + featuresLimit);
    const finalTickerRows = missingAdxOnly
      ? (
          await db.execute(sql`
            SELECT DISTINCT c.ticker
            FROM candles c
            INNER JOIN moex_tickers t ON t.secid = c.ticker AND t.is_active = true
            WHERE c.timeframe = ${TIMEFRAME}
              AND NOT EXISTS (
                SELECT 1
                FROM features f
                WHERE f.ticker = c.ticker
                  AND f.adx IS NOT NULL
              )
            ORDER BY c.ticker
            LIMIT ${featuresLimit}
          `)
        ).rows.map((row) => ({ ticker: String((row as { ticker: string }).ticker) }))
      : tickerRows;
    let refreshed = 0;
    for (const { ticker } of finalTickerRows) {
      const count = await calculateFeatures(ticker);
      refreshed += count;
      console.log(`${ticker}: ${count} признаков обновлено`);
    }
    console.log(
      `Готово. Обновлено признаков: ${refreshed}. Обработано тикеров: ${finalTickerRows.length}`,
    );
    await pool.end();
    return;
  }

  if (booleanArg("latest-only")) {
    const allTickers = await getIMOEXTickers();
    if (allTickers.length === 0) {
      throw new Error("MOEX вернул пустой состав IMOEX; быстрый импорт остановлен");
    }
    const requestedTicker = arg("ticker", "").trim().toUpperCase();
    if (!requestedTicker) {
      await db.update(moexTickers).set({ isActive: false });
      for (let index = 0; index < allTickers.length; index += 1) {
        await saveTicker(allTickers[index], index + 1);
      }
      for (const ticker of SMART_MONEY_TICKER_ROWS) {
        await saveTicker(ticker, 0, false);
      }
    }
    const selectedTickers = requestedTicker
      ? [
          allTickers.find((ticker) => ticker.secid === requestedTicker) ??
            SMART_MONEY_TICKER_ROWS.find((ticker) => ticker.secid === requestedTicker) ?? {
              secid: requestedTicker,
              shortName: null,
              capitalization: undefined,
            },
        ]
      : [
          ...allTickers,
          ...SMART_MONEY_TICKER_ROWS.filter(
            (extra) => !allTickers.some((ticker) => ticker.secid === extra.secid),
          ),
        ];

    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);
    let tickersProcessed = 0;
    let candlesLoaded = 0;
    let featuresCalculated = 0;
    const errors: string[] = [];

    for (const ticker of selectedTickers) {
      try {
        if (requestedTicker) {
          await saveTicker(ticker, 0, false);
        }
        const rows = await loadTimeframeCandles(ticker.secid, startDate, endDate);
        candlesLoaded += await saveCandles(rows);
        if (IS_FEATURE_TIMEFRAME) {
          featuresCalculated += await calculateLatestFeature(ticker.secid);
        }
        tickersProcessed += 1;
      } catch (error) {
        errors.push(
          `${ticker.secid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(REQUEST_DELAY_MS);
    }

    try {
      const indexRows = await loadTimeframeCandles(
        "IMOEX",
        startDate,
        endDate,
        "stock",
        "index",
        "SNDX",
      );
      if (TIMEFRAME in MARKET_CONTEXT_MAX_GAP_MS) {
        const latestIndexTimestamp = indexRows.reduce<Date | null>(
          (latest, row) =>
            !latest || row.timestamp > latest ? row.timestamp : latest,
          null,
        );
        const latestAssetResult = await db.execute(sql`
          SELECT MAX(timestamp) AS latest
          FROM candles
          WHERE timeframe = ${TIMEFRAME}
            AND ticker <> 'IMOEX'
            AND ticker IN (SELECT secid FROM moex_tickers WHERE is_active = true)
        `);
        const rawLatestAsset = (
          latestAssetResult.rows[0] as { latest?: unknown } | undefined
        )?.latest;
        const latestAssetTimestamp =
          rawLatestAsset instanceof Date
            ? rawLatestAsset
            : rawLatestAsset
              ? new Date(String(rawLatestAsset))
              : null;
        const maxGapMs =
          MARKET_CONTEXT_MAX_GAP_MS[TIMEFRAME as keyof typeof MARKET_CONTEXT_MAX_GAP_MS];
        const gapMs =
          latestIndexTimestamp && latestAssetTimestamp
            ? latestAssetTimestamp.getTime() - latestIndexTimestamp.getTime()
            : null;
        if (
          !latestIndexTimestamp ||
          !latestAssetTimestamp ||
          gapMs === null ||
          !Number.isFinite(gapMs) ||
          gapMs > maxGapMs
        ) {
          throw new Error(
            `IMOEX неактуален для ${TIMEFRAME}: индекс ${latestIndexTimestamp?.toISOString() ?? "отсутствует"}, акции ${latestAssetTimestamp?.toISOString() ?? "отсутствуют"}.`,
          );
        }
      }
      candlesLoaded += await saveCandles(indexRows);
      if (IS_FEATURE_TIMEFRAME) {
        featuresCalculated += await calculateLatestFeature("IMOEX");
      }
      if (indexRows.length > 0 && IS_FEATURE_TIMEFRAME) {
        await db
          .insert(marketContext)
          .values(
            indexRows.map((row) => ({
              timestamp: row.timestamp,
              imoexPrice: row.close,
              imoexChange: row.open
                ? ((row.close - row.open) / row.open) * 100
                : undefined,
              imoexVolume: row.volume,
            })),
          )
          .onConflictDoUpdate({
            target: marketContext.timestamp,
            set: {
              imoexPrice: sql.raw('excluded."imoex_price"'),
              imoexChange: sql.raw('excluded."imoex_change"'),
              imoexVolume: sql.raw('excluded."imoex_volume"'),
            },
          });
      }
    } catch (error) {
      // IMOEX intraday candles are not consistently available from MOEX ISS.
      // Stock candles remain usable without this optional market context;
      // Smart Money marks the context as unconfirmed instead of failing the
      // entire refresh and suppressing all stock signals.
      console.warn(
        `Предупреждение IMOEX: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    console.log(
      `Актуальные данные обновлены. Тикеров: ${tickersProcessed}; свечей: ${candlesLoaded}; признаков: ${featuresCalculated}; ошибок: ${errors.length}`,
    );
    if (errors.length) {
      console.error(errors.slice(0, 10).join("\n"));
      process.exitCode = 1;
    }
    await pool.end();
    return;
  }

  const years = Math.max(1, Number(arg("years", "2")));
  const maxTickers = Math.max(1, Math.min(100, integerArg("max-tickers", 100)));
  const startRank = Math.min(99, integerArg("start-rank", 0));
  const skipContext = arg("skip-context", "false") === "true";
  const missingOnly = arg("missing-only", "false") === "true";
  const missingLimit = integerArg("missing-limit", 100);
  const end = new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const run = await db
    .insert(downloadRuns)
    .values({ years, maxTickers, status: "running" })
    .returning({ id: downloadRuns.id });
  const runId = run[0]?.id;
  let tickersProcessed = 0;
  let candlesLoaded = 0;
  let featuresCalculated = 0;
  const errors: string[] = [];

  try {
    await db
      .update(downloadRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: "Прервано новым запуском импорта",
      })
      .where(eq(downloadRuns.status, "running"));
    await db
      .update(downloadRuns)
      .set({ status: "running", finishedAt: null, errorMessage: null })
      .where(eq(downloadRuns.id, runId!));

    console.log("Получаю официальный состав индекса IMOEX...");
    const allTickers = await getIMOEXTickers();
    if (allTickers.length === 0) {
      throw new Error("MOEX вернул пустой состав IMOEX; импорт остановлен");
    }
    const missingTickers = missingOnly
      ? (
          await db.execute(sql`
            SELECT t.secid
            FROM moex_tickers t
            WHERE t.is_active = true
              AND NOT EXISTS (
                SELECT 1
                FROM candles c
                WHERE c.ticker = t.secid
                  AND c.timeframe = ${TIMEFRAME}
              )
            ORDER BY t.rank
            LIMIT ${missingLimit}
          `)
        ).rows.map((row) => {
          const secid = String((row as { secid: string }).secid);
          return allTickers.find((ticker) => ticker.secid === secid);
        }).filter((ticker): ticker is (typeof allTickers)[number] => Boolean(ticker))
      : null;
    const tickers = missingTickers ?? allTickers.slice(startRank, startRank + maxTickers);
    console.log(`Найдено тикеров: ${tickers.length}`);
    // Keep the persisted universe aligned with the current MOEX share list.
    await db.update(moexTickers).set({ isActive: false });
    for (let index = 0; index < allTickers.length; index += 1) {
      await saveTicker(allTickers[index], index + 1);
    }

    for (let index = 0; index < tickers.length; index += 1) {
      const ticker = tickers[index];
      try {
        await saveTicker(ticker, startRank + index + 1);
        const rows = await loadTimeframeCandles(ticker.secid, startDate, endDate);
        const inserted = await saveCandles(rows);
        const featureCount = IS_RAW_ONLY_TIMEFRAME
          ? 0
          : await calculateFeatures(ticker.secid);
        candlesLoaded += inserted;
        featuresCalculated += featureCount;
        tickersProcessed += 1;
        await db
          .update(downloadRuns)
          .set({
            tickersProcessed,
            candlesLoaded,
            featuresCalculated,
            errorCount: errors.length,
            errorMessage: errors.slice(0, 20).join("\n") || null,
          })
          .where(eq(downloadRuns.id, runId!));
        console.log(
          `[${startRank + index + 1}/100] ${ticker.secid}: ${rows.length} свечей, ${featureCount} признаков`,
        );
      } catch (error) {
        const message = `${ticker.secid}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        console.error(`Ошибка: ${message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }

    if (!skipContext) {
      try {
        const indexRows = await loadTimeframeCandles(
          "IMOEX",
          startDate,
          endDate,
          "stock",
          "index",
          "SNDX",
        );
        candlesLoaded += await saveCandles(indexRows);
        if (indexRows.length > 0 && IS_FEATURE_TIMEFRAME) {
          await db
            .insert(marketContext)
            .values(
              indexRows.map((row) => ({
                timestamp: row.timestamp,
                imoexPrice: row.close,
                imoexChange: row.open
                  ? ((row.close - row.open) / row.open) * 100
                  : undefined,
                imoexVolume: row.volume,
              })),
            )
            .onConflictDoNothing({ target: marketContext.timestamp });
        }
        if (IS_FEATURE_TIMEFRAME) {
          featuresCalculated += await calculateFeatures("IMOEX");
        }
        console.log(`IMOEX: ${indexRows.length} свечей`);
      } catch (error) {
        errors.push(
          `IMOEX: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(`Ошибка IMOEX: ${errors.at(-1)}`);
      }
    }

    await db
      .update(downloadRuns)
      .set({
        status: errors.length ? "completed_with_errors" : "completed",
        tickersProcessed,
        candlesLoaded,
        featuresCalculated,
        errorCount: errors.length,
        errorMessage: errors.slice(0, 20).join("\n") || null,
        finishedAt: new Date(),
      })
      .where(eq(downloadRuns.id, runId!));
    console.log(
      `Готово. Тикеров: ${tickersProcessed}; свечей добавлено: ${candlesLoaded}; признаков: ${featuresCalculated}; ошибок: ${errors.length}`,
    );
  } catch (error) {
    await db
      .update(downloadRuns)
      .set({
        status: "failed",
        errorCount: errors.length + 1,
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(downloadRuns.id, runId!));
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});