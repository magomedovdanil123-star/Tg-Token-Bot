/**
 * Per-stock historical setup research powered by T-Invest.
 *
 * This is deliberately separate from the production Smart Money scanner:
 * it downloads a one-year 15m dataset in bounded windows, discovers
 * ticker-specific LONG/SHORT combinations, and writes an auditable report.
 *
 * Required environment:
 *   TINKOFF_INVEST_TOKEN
 *   DATABASE_URL
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run tinvest-stock-analysis
 *   ... --tickers=SBER,ROSN --days=365 --output=/tmp/report.json
 */

import https from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Feature = Candle & {
  session: string;
  hour: number;
  minute: number;
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  aboveVwap: boolean;
  volumeRatio: number | null;
  momentum4: number | null;
  momentum16: number | null;
  breakoutUp: boolean;
  breakoutDown: boolean;
  rangeExpansion: boolean;
  openingHour: boolean;
  closingHour: boolean;
  imoexMomentum4: number | null;
};

type Label = {
  win: boolean;
  targetHit: boolean;
  stopHit: boolean;
  returnPct: number;
  mfe: number;
  mae: number;
};

type Stats = {
  occurrences: number;
  wins: number;
  winRate: number;
  averageReturn: number;
  medianReturn: number;
  profitFactor: number;
  maxDrawdown: number;
  averageMae: number;
  averageMfe: number;
};

type Condition = {
  feature: string;
  label: string;
};

type SetupResult = {
  direction: "LONG" | "SHORT";
  targetPercent: number;
  horizonDays: number;
  conditions: Condition[];
  train: Stats;
  validation: Stats;
  test: Stats;
  confidence: number;
  quality: "validated" | "weak_oos";
};

type TickerReport = {
  ticker: string;
  candles: number;
  firstDate: string | null;
  lastDate: string | null;
  tradingSessions: number;
  dataDays: number;
  status: "ok" | "insufficient_data" | "instrument_not_found" | "error";
  error?: string;
  setups: SetupResult[];
  bestTestWinRate: number | null;
};

type TInvestInstrument = {
  figi?: string;
  ticker?: string;
  name?: string;
  first15mCandleDate?: string;
};

const cli = Object.fromEntries(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value = "true"] = arg.slice(2).split("=");
    return [key, value];
  }),
);

const LOOKBACK_DAYS = Math.max(30, Number(cli.days ?? 365) || 365);
const REQUEST_WINDOW_DAYS = 14;
const REQUEST_DELAY_MS = 120;
const REQUEST_RETRIES = 4;
const MAX_CONCURRENT_TICKERS = 3;
const MIN_TRAIN_OCCURRENCES = Math.max(20, Number(cli["min-occurrences"] ?? 30) || 30);
const MIN_OOS_OCCURRENCES = Math.max(10, Number(cli["min-oos-occurrences"] ?? 15) || 15);
const MIN_TRAIN_WIN_RATE = Number(cli["min-train-win-rate"] ?? 0.6) || 0.6;
const MIN_OOS_WIN_RATE = Number(cli["min-oos-win-rate"] ?? 0.55) || 0.55;
const COST_PERCENT = 0.2;
const TARGETS = [1.5, 2];
const HORIZON_DAYS = [1, 2, 3];
const OUTPUT = String(cli.output ?? `/tmp/tinvest-stock-analysis-${Date.now()}.json`);
const API_HOST = "invest-public-api.tinkoff.ru";
const API_PREFIX = "/rest";
const agent = new https.Agent({ rejectUnauthorized: false });

function token() {
  const value = process.env.TINKOFF_INVEST_TOKEN;
  if (!value) throw new Error("TINKOFF_INVEST_TOKEN is not configured");
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function post<T>(path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = https.request(
      {
        hostname: API_HOST,
        path: API_PREFIX + path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": payload.length,
        },
        agent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            reject(new Error(`T-Invest returned invalid JSON (${response.statusCode})`));
            return;
          }
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`T-Invest ${response.statusCode}: ${String(parsed.message ?? text).slice(0, 300)}`));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    request.setTimeout(45_000, () => request.destroy(new Error("T-Invest request timeout")));
    request.on("error", reject);
    request.end(payload);
  });
}

async function postWithRetry<T>(path: string, body: unknown): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      return await post<T>(path, body);
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) await sleep(attempt * 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function money(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { units?: string | number; nano?: string | number };
  const result = Number(record.units ?? 0) + Number(record.nano ?? 0) / 1e9;
  return Number.isFinite(result) ? result : null;
}

async function lookupInstrument(ticker: string): Promise<TInvestInstrument | null> {
  const result = await postWithRetry<{ instrument?: TInvestInstrument }>(
    "/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy",
    {
      idType: "INSTRUMENT_ID_TYPE_TICKER",
      classCode: "TQBR",
      id: ticker,
    },
  );
  return result.instrument?.figi ? result.instrument : null;
}

async function getCandles(figi: string, from: Date, to: Date): Promise<Candle[]> {
  const result = await postWithRetry<{
    candles?: Array<{
      open?: unknown;
      high?: unknown;
      low?: unknown;
      close?: unknown;
      volume?: string | number;
      time?: string;
      isComplete?: boolean;
    }>;
  }>(
    "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles",
    {
      figi,
      from: from.toISOString(),
      to: to.toISOString(),
      interval: "CANDLE_INTERVAL_15_MIN",
    },
  );
  return (result.candles ?? [])
    .filter((row) => row.isComplete !== false)
    .map((row) => ({
      time: new Date(String(row.time)),
      open: money(row.open) ?? Number.NaN,
      high: money(row.high) ?? Number.NaN,
      low: money(row.low) ?? Number.NaN,
      close: money(row.close) ?? Number.NaN,
      volume: Number(row.volume ?? 0),
    }))
    .filter((row) =>
      Number.isFinite(row.time.getTime()) &&
      [row.open, row.high, row.low, row.close].every(Number.isFinite) &&
      row.close > 0,
    );
}

async function loadTickerCandles(figi: string): Promise<Candle[]> {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const result = new Map<number, Candle>();
  let cursor = start;
  let windows = 0;
  while (cursor < end) {
    const windowEnd = new Date(
      Math.min(end.getTime(), cursor.getTime() + REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    );
    const rows = await getCandles(figi, cursor, windowEnd);
    for (const row of rows) {
      if (row.time >= start && row.time <= end) result.set(row.time.getTime(), row);
    }
    windows += 1;
    process.stdout.write(`.`);
    cursor = new Date(windowEnd.getTime() + 60_000);
    await sleep(REQUEST_DELAY_MS);
  }
  process.stdout.write(` ${windows} окон\n`);
  return [...result.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
}

function sessionKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function moscowParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0),
  };
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
}

function emaSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length < period) return result;
  let current = average(values.slice(0, period))!;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index]! - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function rsiSeries(values: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  result[period] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    gains = (gains * (period - 1) + Math.max(delta, 0)) / period;
    losses = (losses * (period - 1) + Math.max(-delta, 0)) / period;
    result[index] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }
  return result;
}

function makeFeatures(candles: Candle[], benchmark: Map<number, Candle>): Feature[] {
  const closes = candles.map((row) => row.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const rsi = rsiSeries(closes);
  const result: Feature[] = [];
  let sessionVolume = 0;
  let sessionValue = 0;
  let activeSession = "";
  for (let index = 0; index < candles.length; index += 1) {
    const row = candles[index]!;
    const session = sessionKey(row.time);
    if (session !== activeSession) {
      activeSession = session;
      sessionVolume = 0;
      sessionValue = 0;
    }
    sessionVolume += row.volume;
    sessionValue += row.close * row.volume;
    const prior = candles[index - 20] ? candles.slice(index - 20, index) : [];
    const priorVolume = average(prior.map((item) => item.volume));
    const priorHigh = prior.length ? Math.max(...prior.map((item) => item.high)) : null;
    const priorLow = prior.length ? Math.min(...prior.map((item) => item.low)) : null;
    const previousRange = candles[index - 1]
      ? candles[index - 1]!.high - candles[index - 1]!.low
      : null;
    const currentRange = row.high - row.low;
    const time = moscowParts(row.time);
    const benchmarkRow = benchmark.get(row.time.getTime());
    const benchmarkPrevious = benchmark.get(candles[index - 4]?.time.getTime() ?? -1);
    const benchmarkMomentum = benchmarkRow && benchmarkPrevious
      ? ((benchmarkRow.close - benchmarkPrevious.close) / benchmarkPrevious.close) * 100
      : null;
    result.push({
      ...row,
      session,
      hour: time.hour,
      minute: time.minute,
      rsi: rsi[index],
      ema20: ema20[index],
      ema50: ema50[index],
      aboveVwap: sessionVolume > 0 && row.close >= sessionValue / sessionVolume,
      volumeRatio: priorVolume ? row.volume / priorVolume : null,
      momentum4: candles[index - 4]
        ? ((row.close - candles[index - 4]!.close) / candles[index - 4]!.close) * 100
        : null,
      momentum16: candles[index - 16]
        ? ((row.close - candles[index - 16]!.close) / candles[index - 16]!.close) * 100
        : null,
      breakoutUp: priorHigh !== null && row.close > priorHigh,
      breakoutDown: priorLow !== null && row.close < priorLow,
      rangeExpansion: previousRange !== null && currentRange > previousRange * 1.5,
      openingHour: time.hour === 10 || (time.hour === 11 && time.minute < 30),
      closingHour: time.hour >= 17,
      imoexMomentum4: benchmarkMomentum,
    });
  }
  return result;
}

function buildFutureEnds(features: Feature[]): Map<string, number[]> {
  const sessions = [...new Set(features.map((row) => row.session))];
  const sessionIndex = new Map(sessions.map((session, index) => [session, index]));
  const ends = new Map<string, number[]>();
  for (let index = 0; index < features.length; index += 1) {
    const current = sessionIndex.get(features[index]!.session)!;
    const values: number[] = [];
    for (const days of HORIZON_DAYS) {
      const targetSession = sessions[current + days];
      if (!targetSession) {
        values.push(-1);
        continue;
      }
      let end = index;
      for (let cursor = index + 1; cursor < features.length; cursor += 1) {
        if (features[cursor]!.session === targetSession) end = cursor;
        if (features[cursor]!.session > targetSession) break;
      }
      values.push(end > index ? end : -1);
    }
    ends.set(`${features[index]!.time.getTime()}`, values);
  }
  return ends;
}

function label(features: Feature[], ends: Map<string, number[]>, index: number, target: number, horizon: number, direction: "LONG" | "SHORT"): Label | null {
  const horizonIndex = HORIZON_DAYS.indexOf(horizon as 1 | 2 | 3);
  const end = ends.get(String(features[index]!.time.getTime()))?.[horizonIndex];
  if (!end || end <= index) return null;
  const entry = features[index]!.close;
  const targetPrice = direction === "LONG" ? entry * (1 + target / 100) : entry * (1 - target / 100);
  const stopPrice = direction === "LONG" ? entry * (1 - target / 100) : entry * (1 + target / 100);
  let targetHit = false;
  let stopHit = false;
  let targetAt = Number.POSITIVE_INFINITY;
  let stopAt = Number.POSITIVE_INFINITY;
  let mfe = 0;
  let mae = 0;
  for (let cursor = index + 1; cursor <= end; cursor += 1) {
    const row = features[cursor]!;
    const favourable = direction === "LONG"
      ? ((row.high - entry) / entry) * 100
      : ((entry - row.low) / entry) * 100;
    const adverse = direction === "LONG"
      ? ((entry - row.low) / entry) * 100
      : ((row.high - entry) / entry) * 100;
    mfe = Math.max(mfe, favourable);
    mae = Math.max(mae, adverse);
    if (!targetHit && (direction === "LONG" ? row.high >= targetPrice : row.low <= targetPrice)) {
      targetHit = true;
      targetAt = cursor;
    }
    if (!stopHit && (direction === "LONG" ? row.low <= stopPrice : row.high >= stopPrice)) {
      stopHit = true;
      stopAt = cursor;
    }
  }
  const win = targetHit && (!stopHit || targetAt < stopAt);
  const last = features[end]!.close;
  const rawReturn = direction === "LONG"
    ? ((last - entry) / entry) * 100
    : ((entry - last) / entry) * 100;
  return {
    win,
    targetHit,
    stopHit,
    returnPct: win ? target - COST_PERCENT : rawReturn - COST_PERCENT,
    mfe,
    mae,
  };
}

function conditionValue(feature: Feature, name: string): boolean {
  switch (name) {
    case "rsi_low": return (feature.rsi ?? 50) < 35;
    case "rsi_high": return (feature.rsi ?? 50) > 65;
    case "ema_bull": return feature.ema20 !== null && feature.ema50 !== null && feature.ema20 > feature.ema50;
    case "ema_bear": return feature.ema20 !== null && feature.ema50 !== null && feature.ema20 < feature.ema50;
    case "above_vwap": return feature.aboveVwap;
    case "below_vwap": return !feature.aboveVwap;
    case "volume_high": return (feature.volumeRatio ?? 0) >= 1.5;
    case "volume_spike": return (feature.volumeRatio ?? 0) >= 2;
    case "momentum_up": return (feature.momentum4 ?? 0) > 0.2 && (feature.momentum16 ?? 0) > 0;
    case "momentum_down": return (feature.momentum4 ?? 0) < -0.2 && (feature.momentum16 ?? 0) < 0;
    case "breakout_up": return feature.breakoutUp;
    case "breakout_down": return feature.breakoutDown;
    case "range_expansion": return feature.rangeExpansion;
    case "opening_hour": return feature.openingHour;
    case "closing_hour": return feature.closingHour;
    case "imoex_up": return (feature.imoexMomentum4 ?? 0) > 0.15;
    case "imoex_down": return (feature.imoexMomentum4 ?? 0) < -0.15;
    default: return false;
  }
}

const CONDITION_DEFS: Condition[] = [
  { feature: "rsi_low", label: "RSI < 35" },
  { feature: "rsi_high", label: "RSI > 65" },
  { feature: "ema_bull", label: "EMA20 > EMA50" },
  { feature: "ema_bear", label: "EMA20 < EMA50" },
  { feature: "above_vwap", label: "Цена выше VWAP" },
  { feature: "below_vwap", label: "Цена ниже VWAP" },
  { feature: "volume_high", label: "Volume Ratio ≥ 1.5x" },
  { feature: "volume_spike", label: "Volume Ratio ≥ 2x" },
  { feature: "momentum_up", label: "Импульс 1ч/4ч вверх" },
  { feature: "momentum_down", label: "Импульс 1ч/4ч вниз" },
  { feature: "breakout_up", label: "Пробой максимума 5ч" },
  { feature: "breakout_down", label: "Пробой минимума 5ч" },
  { feature: "range_expansion", label: "Расширение диапазона" },
  { feature: "opening_hour", label: "Первые 90 минут" },
  { feature: "closing_hour", label: "Последний час" },
  { feature: "imoex_up", label: "IMOEX растёт" },
  { feature: "imoex_down", label: "IMOEX падает" },
];

function stats(labels: Label[], indexes: number[]): Stats | null {
  if (indexes.length === 0) return null;
  const selected = indexes.map((index) => labels[index]!);
  const returns = selected.map((item) => item.returnPct);
  const wins = selected.filter((item) => item.win).length;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const grossWins = selected.filter((item) => item.returnPct > 0).reduce((sum, item) => sum + item.returnPct, 0);
  const grossLosses = Math.abs(selected.filter((item) => item.returnPct < 0).reduce((sum, item) => sum + item.returnPct, 0));
  return {
    occurrences: selected.length,
    wins,
    winRate: wins / selected.length,
    averageReturn: average(returns) ?? 0,
    medianReturn: median(returns),
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0,
    maxDrawdown,
    averageMae: average(selected.map((item) => item.mae)) ?? 0,
    averageMfe: average(selected.map((item) => item.mfe)) ?? 0,
  };
}

function uniqueSessionIndexes(features: Feature[], indexes: number[]): number[] {
  const seen = new Set<string>();
  return indexes.filter((index) => {
    const session = features[index]!.session;
    if (seen.has(session)) return false;
    seen.add(session);
    return true;
  });
}

function confidence(train: Stats, validation: Stats, test: Stats): number {
  const consistency = Math.max(0, 1 - Math.abs(train.winRate - test.winRate));
  const sample = Math.min(1, test.occurrences / 60);
  const rate = Math.max(0, Math.min(1, (test.winRate - 0.5) / 0.3));
  return Math.round((rate * 50 + consistency * 25 + sample * 25));
}

function discover(features: Feature[], target: number, horizon: number, direction: "LONG" | "SHORT"): SetupResult[] {
  const ends = buildFutureEnds(features);
  const labels = features.map((_feature, index) => label(features, ends, index, target, horizon, direction));
  const usable = labels.map((item, index) => item ? index : -1).filter((index) => index >= 0);
  const trainEnd = Math.floor(features.length * 0.6);
  const validationEnd = Math.floor(features.length * 0.8);
  const trainIndexes = usable.filter((index) => index < trainEnd);
  const validationIndexes = usable.filter((index) => index >= trainEnd && index < validationEnd);
  const testIndexes = usable.filter((index) => index >= validationEnd);
  if (trainIndexes.length < MIN_TRAIN_OCCURRENCES * 2 || validationIndexes.length < MIN_OOS_OCCURRENCES || testIndexes.length < MIN_OOS_OCCURRENCES) return [];

  const singleScores = CONDITION_DEFS.map((condition, conditionIndex) => {
    const indexes = uniqueSessionIndexes(features, trainIndexes.filter((index) => conditionValue(features[index]!, condition.feature)));
    const selected = indexes.map((index) => labels[index]!);
    const winRate = selected.length ? selected.filter((item) => item.win).length / selected.length : 0;
    return { conditionIndex, winRate, occurrences: selected.length };
  }).filter((item) => item.occurrences >= MIN_TRAIN_OCCURRENCES).sort((a, b) => b.winRate - a.winRate).slice(0, 12);

  const candidates: number[][] = singleScores.filter((item) => item.winRate >= MIN_TRAIN_WIN_RATE).map((item) => [item.conditionIndex]);
  for (let left = 0; left < singleScores.length; left += 1) {
    for (let right = left + 1; right < singleScores.length; right += 1) {
      const a = CONDITION_DEFS[singleScores[left]!.conditionIndex]!;
      const b = CONDITION_DEFS[singleScores[right]!.conditionIndex]!;
      const indexes = uniqueSessionIndexes(features, trainIndexes.filter((index) => conditionValue(features[index]!, a.feature) && conditionValue(features[index]!, b.feature)));
      const selected = indexes.map((index) => labels[index]!);
      const winRate = selected.length ? selected.filter((item) => item.win).length / selected.length : 0;
      if (selected.length >= MIN_TRAIN_OCCURRENCES && winRate >= MIN_TRAIN_WIN_RATE) {
        candidates.push([singleScores[left]!.conditionIndex, singleScores[right]!.conditionIndex]);
      }
    }
  }

  const results: SetupResult[] = [];
  const seen = new Set<string>();
  for (const indexes of candidates) {
    const conditions = indexes.map((index) => CONDITION_DEFS[index]!);
    const key = conditions.map((condition) => condition.feature).sort().join("+");
    if (seen.has(key)) continue;
    seen.add(key);
    const matching = (source: number[]) => uniqueSessionIndexes(features, source.filter((index) => conditions.every((condition) => conditionValue(features[index]!, condition.feature))));
    const train = stats(labels as Label[], matching(trainIndexes));
    const validation = stats(labels as Label[], matching(validationIndexes));
    const test = stats(labels as Label[], matching(testIndexes));
    if (!train || !validation || !test) continue;
    if (train.winRate < MIN_TRAIN_WIN_RATE || validation.winRate < MIN_OOS_WIN_RATE || test.winRate < MIN_OOS_WIN_RATE) continue;
    results.push({
      direction,
      targetPercent: target,
      horizonDays: horizon,
      conditions,
      train,
      validation,
      test,
      confidence: confidence(train, validation, test),
      quality: test.winRate >= 0.6 ? "validated" : "weak_oos",
    });
  }
  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

async function getTickers(): Promise<string[]> {
  const selected = cli.tickers
    ? String(cli.tickers).split(",").map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)
    : null;
  if (selected?.length) return selected;
  const result = await db.execute<{ secid: string }>(sql`
    SELECT secid
    FROM moex_tickers
    WHERE is_active = true
      AND secid <> 'IMOEX'
      AND secid NOT LIKE '%USDT'
    ORDER BY rank NULLS LAST, secid
  `);
  return result.rows.map((row) => row.secid);
}

async function analyzeTicker(ticker: string, benchmark: Map<number, Candle>): Promise<TickerReport> {
  process.stdout.write(`${ticker}: `);
  try {
    const instrument = await lookupInstrument(ticker);
    if (!instrument?.figi) {
      process.stdout.write("instrument not found\n");
      return { ticker, candles: 0, firstDate: null, lastDate: null, tradingSessions: 0, dataDays: 0, status: "instrument_not_found", setups: [], bestTestWinRate: null };
    }
    const candles = await loadTickerCandles(instrument.figi);
    const sessions = new Set(candles.map((row) => sessionKey(row.time)));
    const firstDate = candles[0]?.time.toISOString() ?? null;
    const lastDate = candles.at(-1)?.time.toISOString() ?? null;
    const dataDays = firstDate && lastDate ? (new Date(lastDate).getTime() - new Date(firstDate).getTime()) / 86400000 : 0;
    if (candles.length < 500 || dataDays < 300 || sessions.size < 80) {
      return { ticker, candles: candles.length, firstDate, lastDate, tradingSessions: sessions.size, dataDays, status: "insufficient_data", setups: [], bestTestWinRate: null };
    }
    const features = makeFeatures(candles, benchmark);
    const setups = TARGETS.flatMap((target) =>
      HORIZON_DAYS.flatMap((horizon) => [
        ...discover(features, target, horizon, "LONG"),
        ...discover(features, target, horizon, "SHORT"),
      ]),
    ).sort((a, b) => b.confidence - a.confidence).slice(0, 20);
    return {
      ticker,
      candles: candles.length,
      firstDate,
      lastDate,
      tradingSessions: sessions.size,
      dataDays,
      status: "ok",
      setups,
      bestTestWinRate: setups.length ? Math.max(...setups.map((setup) => setup.test.winRate)) : null,
    };
  } catch (error) {
    process.stdout.write(`error: ${String(error).slice(0, 180)}\n`);
    return { ticker, candles: 0, firstDate: null, lastDate: null, tradingSessions: 0, dataDays: 0, status: "error", error: String(error), setups: [], bestTestWinRate: null };
  }
}

async function loadBenchmark(tickers: string[]): Promise<Map<number, Candle>> {
  if (cli["no-benchmark"] === "true") return new Map();
  const instrument = await lookupInstrument("IMOEX");
  if (!instrument?.figi) return new Map();
  process.stdout.write("IMOEX benchmark: ");
  const candles = await loadTickerCandles(instrument.figi);
  process.stdout.write(`benchmark candles=${candles.length}\n`);
  return new Map(candles.map((row) => [row.time.getTime(), row]));
}

async function main() {
  const tickers = await getTickers();
  const benchmark = await loadBenchmark(tickers);
  const reports: TickerReport[] = [];
  for (let index = 0; index < tickers.length; index += MAX_CONCURRENT_TICKERS) {
    const batch = tickers.slice(index, index + MAX_CONCURRENT_TICKERS);
    const results = await Promise.all(batch.map((ticker) => analyzeTicker(ticker, benchmark)));
    reports.push(...results);
    process.stdout.write(`Progress: ${Math.min(index + batch.length, tickers.length)}/${tickers.length}\n`);
  }
  reports.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const output = {
    generatedAt: new Date().toISOString(),
    methodology: {
      source: "T-Invest GetCandles",
      interval: "15m",
      lookbackDays: LOOKBACK_DAYS,
      targets: TARGETS,
      horizonsTradingDays: HORIZON_DAYS,
      costPercentRoundTrip: COST_PERCENT,
      split: "train 60% / validation 20% / out-of-sample test 20%",
      minimumTrainOccurrences: MIN_TRAIN_OCCURRENCES,
      minimumOosOccurrences: MIN_OOS_OCCURRENCES,
      minimumTrainWinRate: MIN_TRAIN_WIN_RATE,
      minimumOosWinRate: MIN_OOS_WIN_RATE,
      sameSessionDeduplication: true,
      sameCandleTpSl: "conservative loss",
      orderBookHistory: "not available; not used",
      liveStrategyChanged: false,
    },
    summary: {
      tickers: reports.length,
      ok: reports.filter((report) => report.status === "ok").length,
      insufficientData: reports.filter((report) => report.status === "insufficient_data").length,
      instrumentNotFound: reports.filter((report) => report.status === "instrument_not_found").length,
      errors: reports.filter((report) => report.status === "error").length,
      totalSetups: reports.reduce((sum, report) => sum + report.setups.length, 0),
      tickersWithSetups: reports.filter((report) => report.setups.length > 0).length,
      setupsWithTestWinRateAtLeast70: reports.flatMap((report) => report.setups).filter((setup) => setup.test.winRate >= 0.7).length,
    },
    reports,
  };
  await mkdir(OUTPUT.substring(0, OUTPUT.lastIndexOf("/")) || ".", { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(output, null, 2));
  process.stdout.write(`REPORT=${OUTPUT}\n`);
  process.stdout.write(JSON.stringify(output.summary) + "\n");
}

main()
  .catch((error) => {
    process.stderr.write(`Fatal: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });