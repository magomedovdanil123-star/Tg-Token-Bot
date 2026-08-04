import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  candles,
  db,
  featureCombinations,
  features,
  assetCorrelations,
  marketContext,
  marketLevels,
  moexTickers,
  patterns,
  pool,
  signalsHistory,
} from "@workspace/db";
import { logger } from "./logger";

const TELEGRAM_API = "https://api.telegram.org";
const TIMEFRAME = "10m";
const POLL_TIMEOUT_SECONDS = 25;

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string; username?: string };
  };
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type LatestFeature = {
  timestamp: Date;
  close: number;
  ema20: number | null;
  ema50: number | null;
  rsi: number | null;
  macdHist: number | null;
  relativeVolume: number | null;
  atr: number | null;
  bbMiddle: number | null;
  historicalVolatility: number | null;
  isDoji: number | null;
  isHammer: number | null;
  isEngulfing: number | null;
  isInsideBar: number | null;
  isOutsideBar: number | null;
};

type LatestMarket = {
  timestamp: Date;
  imoexPrice: number | null;
  imoexChange: number | null;
};

type TopRow = LatestFeature & { ticker: string };
type SignalDirection = "BUY" | "SELL" | "HOLD";
type Combination = {
  id: number;
  name: string;
  conditions: Record<string, unknown>[];
  direction: string | null;
  successRate: number | null;
  expectedValue: number | null;
  occurrences: number;
  holdingMinutes: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
};
type CandlePattern = {
  id: number;
  name: string;
  direction: string | null;
  successRate: number | null;
  profitFactor: number | null;
  occurrences: number;
  averageProfit: number | null;
};
type MarketStructure = {
  support: number | null;
  resistance: number | null;
  correlation: number | null;
  correlationSamples: number | null;
};
type SignalContext = {
  combinations: Combination[];
  volatilityMedian: number | null;
  patternsByTicker: Map<string, CandlePattern[]>;
  levelsByTicker: Map<string, { levelType: string; price: number }[]>;
  correlationsByTicker: Map<
    string,
    { correlation: number | null; sampleCount: number | null }
  >;
};

let cachedSignalContext: { value: SignalContext; expiresAt: number } | null =
  null;

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function directionLabel(direction: SignalDirection) {
  if (direction === "BUY") return "ПОКУПКА";
  if (direction === "SELL") return "ПРОДАЖА";
  return "НАБЛЮДАТЬ";
}

function scoreFeature(feature: LatestFeature): {
  score: number;
  direction: SignalDirection;
  confidence: number;
  reasons: string[];
} {
  let score = 50;
  const reasons: string[] = [];

  if (feature.ema20 !== null && feature.ema50 !== null) {
    if (feature.ema20 > feature.ema50) {
      score += 15;
      reasons.push("EMA20 выше EMA50");
    } else if (feature.ema20 < feature.ema50) {
      score -= 15;
      reasons.push("EMA20 ниже EMA50");
    }
  }

  if (feature.rsi !== null) {
    if (feature.rsi < 30) {
      score += 12;
      reasons.push(`RSI в перепроданности (${formatNumber(feature.rsi)})`);
    } else if (feature.rsi > 70) {
      score -= 12;
      reasons.push(`RSI в перекупленности (${formatNumber(feature.rsi)})`);
    } else {
      reasons.push(`RSI ${formatNumber(feature.rsi)}`);
    }
  }

  if (feature.macdHist !== null) {
    if (feature.macdHist > 0) {
      score += 10;
      reasons.push("MACD-гистограмма положительная");
    } else if (feature.macdHist < 0) {
      score -= 10;
      reasons.push("MACD-гистограмма отрицательная");
    }
  }

  if (feature.relativeVolume !== null && feature.relativeVolume >= 1.5) {
    const volumePercent = Math.round((feature.relativeVolume - 1) * 100);
    reasons.push(`объём выше среднего на ${volumePercent}%`);
    if (score >= 50) score += 8;
    else score -= 8;
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const direction =
    boundedScore >= 60 ? "BUY" : boundedScore <= 40 ? "SELL" : "HOLD";
  const confidence = Math.min(
    95,
    Math.max(50, Math.round(50 + Math.abs(boundedScore - 50) * 1.5)),
  );

  return { score: boundedScore, direction, confidence, reasons };
}

async function getLatestFeature(ticker: string): Promise<LatestFeature | null> {
  const result = await db
    .select({
      timestamp: candles.timestamp,
      close: candles.close,
      ema20: features.ema20,
      ema50: features.ema50,
      rsi: features.rsi,
      macdHist: features.macdHist,
      relativeVolume: features.relativeVolume,
      atr: features.atr,
      bbMiddle: features.bbMiddle,
      historicalVolatility: features.historicalVolatility,
      isDoji: features.isDoji,
      isHammer: features.isHammer,
      isEngulfing: features.isEngulfing,
      isInsideBar: features.isInsideBar,
      isOutsideBar: features.isOutsideBar,
    })
    .from(features)
    .innerJoin(
      candles,
      and(
        eq(candles.ticker, features.ticker),
        eq(candles.timeframe, TIMEFRAME),
        eq(candles.timestamp, features.timestamp),
      ),
    )
    .innerJoin(moexTickers, eq(moexTickers.secid, features.ticker))
    .where(
      and(
        eq(features.ticker, ticker),
        eq(moexTickers.isActive, true),
      ),
    )
    .orderBy(desc(features.timestamp))
    .limit(1);
  return result[0] ?? null;
}

async function getLatestMarket(): Promise<LatestMarket | null> {
  const result = await db
    .select({
      timestamp: marketContext.timestamp,
      imoexPrice: marketContext.imoexPrice,
      imoexChange: marketContext.imoexChange,
    })
    .from(marketContext)
    .orderBy(desc(marketContext.timestamp))
    .limit(1);
  return result[0] ?? null;
}

async function getTopRows() {
  const result = await db.execute(sql`
    SELECT
      t.secid AS ticker,
      f.timestamp,
      c.close,
      f.ema_20 AS "ema20",
      f.ema_50 AS "ema50",
      f.rsi,
      f.macd_hist AS "macdHist",
      f.relative_volume AS "relativeVolume",
      f.atr,
      f.bb_middle AS "bbMiddle",
      f.historical_volatility AS "historicalVolatility",
      f.is_doji AS "isDoji",
      f.is_hammer AS "isHammer",
      f.is_engulfing AS "isEngulfing",
      f.is_inside_bar AS "isInsideBar",
      f.is_outside_bar AS "isOutsideBar"
    FROM moex_tickers t
    CROSS JOIN LATERAL (
      SELECT
        f.timestamp,
        f.candle_id,
        f.ema_20,
        f.ema_50,
        f.rsi,
        f.macd_hist,
        f.relative_volume,
        f.atr,
        f.bb_middle,
        f.historical_volatility,
        f.is_doji,
        f.is_hammer,
        f.is_engulfing,
        f.is_inside_bar,
        f.is_outside_bar
      FROM features f
      WHERE f.ticker = t.secid
      ORDER BY f.timestamp DESC
      LIMIT 1
    ) f
    INNER JOIN candles c
      ON c.id = f.candle_id
      AND c.timeframe = ${TIMEFRAME}
    WHERE t.is_active = true
      AND t.secid <> 'IMOEX'
  `);
  return result.rows as unknown as TopRow[];
}

async function getValidatedCombinations(): Promise<Combination[]> {
  const result = await db
    .select({
      id: featureCombinations.id,
      name: featureCombinations.name,
      conditions: featureCombinations.conditions,
      direction: featureCombinations.direction,
      successRate: featureCombinations.successRate,
      expectedValue: featureCombinations.expectedValue,
      occurrences: featureCombinations.occurrences,
      holdingMinutes: featureCombinations.holdingMinutes,
      confidenceLow: featureCombinations.confidenceLow,
      confidenceHigh: featureCombinations.confidenceHigh,
    })
    .from(featureCombinations)
    .where(eq(featureCombinations.isActive, true))
    .orderBy(desc(featureCombinations.expectedValue));
  return result as Combination[];
}

function matchesCombination(
  feature: LatestFeature,
  combination: Combination,
  volatilityMedian: number | null,
) {
  return combination.conditions.every((condition) => {
    const key = String(condition.key ?? "");
    switch (key) {
      case "rsi_oversold":
        return feature.rsi !== null && feature.rsi < 30;
      case "rsi_overbought":
        return feature.rsi !== null && feature.rsi > 70;
      case "relative_volume_spike":
        return feature.relativeVolume !== null && feature.relativeVolume >= 1.5;
      case "ema_bullish":
        return feature.ema20 !== null && feature.ema50 !== null && feature.ema20 > feature.ema50;
      case "ema_bearish":
        return feature.ema20 !== null && feature.ema50 !== null && feature.ema20 < feature.ema50;
      case "macd_positive":
        return feature.macdHist !== null && feature.macdHist > 0;
      case "macd_negative":
        return feature.macdHist !== null && feature.macdHist < 0;
      case "bb_lower_half":
        return feature.bbMiddle !== null && feature.close < feature.bbMiddle;
      case "bb_upper_half":
        return feature.bbMiddle !== null && feature.close > feature.bbMiddle;
      case "high_volatility":
        return (
          feature.historicalVolatility !== null &&
          volatilityMedian !== null &&
          feature.historicalVolatility >= volatilityMedian
        );
      default:
        return false;
    }
  });
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function getVolatilityMedian() {
  const result = await db.execute(
    sql`SELECT historical_volatility
        FROM features
        WHERE ticker = 'IMOEX'
        ORDER BY timestamp DESC
        LIMIT 1`,
  );
  const values = result.rows
    .map((row) =>
      Number(
        (row as { historical_volatility?: number | string | null })
          .historical_volatility,
      ),
    )
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values[0];
}

function marketStructureFromContext(
  ticker: string,
  currentPrice: number,
  context: SignalContext,
): MarketStructure {
  const levels = context.levelsByTicker.get(ticker) ?? [];
  const supports = levels
    .filter((level) => level.levelType === "support")
    .map((level) => level.price)
    .filter((price) => Number.isFinite(price) && price <= currentPrice);
  const resistances = levels
    .filter((level) => level.levelType === "resistance")
    .map((level) => level.price)
    .filter((price) => Number.isFinite(price) && price >= currentPrice);
  const correlation = context.correlationsByTicker.get(ticker);
  return {
    support: supports.length ? Math.max(...supports) : null,
    resistance: resistances.length ? Math.min(...resistances) : null,
    correlation: correlation?.correlation ?? null,
    correlationSamples: correlation?.sampleCount ?? null,
  };
}

async function getSignalContext(volatilityValues: number[] = []): Promise<SignalContext> {
  if (cachedSignalContext && cachedSignalContext.expiresAt > Date.now()) {
    return cachedSignalContext.value;
  }
  const [combinations, patternRows, levelRows, correlationRows] =
    await Promise.all([
      getValidatedCombinations(),
      db
        .select({
          ticker: patterns.ticker,
          id: patterns.id,
          name: patterns.name,
          direction: patterns.direction,
          successRate: patterns.successRate,
          profitFactor: patterns.profitFactor,
          occurrences: patterns.occurrences,
          averageProfit: patterns.averageProfit,
        })
        .from(patterns)
        .where(eq(patterns.isActive, true))
        .orderBy(desc(patterns.successRate)),
      db
        .select({
          ticker: marketLevels.ticker,
          levelType: marketLevels.levelType,
          price: marketLevels.price,
        })
        .from(marketLevels)
        .where(eq(marketLevels.timeframe, TIMEFRAME)),
      db
        .select({
          ticker: assetCorrelations.assetTicker,
          correlation: assetCorrelations.correlation,
          sampleCount: assetCorrelations.sampleCount,
        })
        .from(assetCorrelations)
        .where(
          and(
            eq(assetCorrelations.benchmarkTicker, "IMOEX"),
            eq(assetCorrelations.timeframe, TIMEFRAME),
          ),
        ),
    ]);
  const volatilityMedian =
    median(volatilityValues) ?? (await getVolatilityMedian());

  const patternsByTicker = new Map<string, CandlePattern[]>();
  for (const pattern of patternRows) {
    const current = patternsByTicker.get(pattern.ticker) ?? [];
    current.push(pattern);
    patternsByTicker.set(pattern.ticker, current);
  }
  const levelsByTicker = new Map<
    string,
    { levelType: string; price: number }[]
  >();
  for (const level of levelRows) {
    const current = levelsByTicker.get(level.ticker) ?? [];
    current.push({ levelType: level.levelType, price: level.price });
    levelsByTicker.set(level.ticker, current);
  }
  const correlationsByTicker = new Map<
    string,
    { correlation: number | null; sampleCount: number | null }
  >();
  for (const correlation of correlationRows) {
    correlationsByTicker.set(correlation.ticker, {
      correlation: correlation.correlation,
      sampleCount: correlation.sampleCount,
    });
  }
  const context = {
    combinations,
    volatilityMedian,
    patternsByTicker,
    levelsByTicker,
    correlationsByTicker,
  };
  cachedSignalContext = {
    value: context,
    expiresAt: Date.now() + 60_000,
  };
  return context;
}

async function getValidatedPatterns(ticker: string): Promise<CandlePattern[]> {
  return db
    .select({
      id: patterns.id,
      name: patterns.name,
      direction: patterns.direction,
      successRate: patterns.successRate,
      profitFactor: patterns.profitFactor,
      occurrences: patterns.occurrences,
      averageProfit: patterns.averageProfit,
    })
    .from(patterns)
    .where(and(eq(patterns.ticker, ticker), eq(patterns.isActive, true)))
    .orderBy(desc(patterns.successRate));
}

function matchesCandlePattern(feature: LatestFeature, pattern: CandlePattern) {
  switch (pattern.name) {
    case "Doji":
      return feature.isDoji === 1;
    case "Hammer":
      return feature.isHammer === 1;
    case "Engulfing":
      return feature.isEngulfing === 1;
    case "Inside Bar":
      return feature.isInsideBar === 1;
    case "Outside Bar":
      return feature.isOutsideBar === 1;
    default:
      return false;
  }
}

async function analyzeSignal(ticker: string, feature: LatestFeature): Promise<{
  direction: SignalDirection;
  confidence: number;
  reasons: string[];
  stop: number;
  target: number;
  horizonMinutes: number;
  matched: Combination[];
  matchedPatterns: CandlePattern[];
  marketStructure: MarketStructure;
}> {
  return analyzeSignalWithContext(ticker, feature, await getSignalContext());
}

async function analyzeSignalWithContext(
  ticker: string,
  feature: LatestFeature,
  context: SignalContext,
): Promise<{
  direction: SignalDirection;
  confidence: number;
  reasons: string[];
  stop: number;
  target: number;
  horizonMinutes: number;
  matched: Combination[];
  matchedPatterns: CandlePattern[];
  marketStructure: MarketStructure;
}> {
  const combinations = context.combinations;
  const volatilityMedian = context.volatilityMedian;
  const candlePatterns = context.patternsByTicker.get(ticker) ?? [];
  const marketStructure = marketStructureFromContext(
    ticker,
    feature.close,
    context,
  );
  const matched = combinations.filter((combination) =>
    matchesCombination(feature, combination, volatilityMedian),
  );
  const matchedPatterns = candlePatterns.filter((pattern) =>
    matchesCandlePattern(feature, pattern),
  );
  if (!matched.length && !matchedPatterns.length) {
    return {
      direction: "HOLD" as SignalDirection,
      confidence: 50,
      reasons: ["Нет совпадения с подтверждённой исторической закономерностью"],
      stop: feature.close * 0.99,
      target: feature.close * 1.01,
      horizonMinutes: 60,
      matched: [] as Combination[],
      matchedPatterns: [],
      marketStructure,
    };
  }

  const buyEvidence = matched
    .filter((combination) => combination.direction === "BUY")
    .reduce((sum, combination) => sum + Math.max(combination.expectedValue ?? 0, 0), 0);
  const sellEvidence = matched
    .filter((combination) => combination.direction === "SELL")
    .reduce((sum, combination) => sum + Math.max(combination.expectedValue ?? 0, 0), 0);
  const buyPatternEvidence = matchedPatterns
    .filter((pattern) => pattern.direction === "BUY")
    .reduce((sum, pattern) => sum + Math.max((pattern.successRate ?? 0.5) - 0.5, 0), 0);
  const sellPatternEvidence = matchedPatterns
    .filter((pattern) => pattern.direction === "SELL")
    .reduce((sum, pattern) => sum + Math.max((pattern.successRate ?? 0.5) - 0.5, 0), 0);
  const totalBuyEvidence = buyEvidence + buyPatternEvidence;
  const totalSellEvidence = sellEvidence + sellPatternEvidence;
  const direction: SignalDirection =
    totalBuyEvidence === totalSellEvidence
      ? "HOLD"
      : totalBuyEvidence > totalSellEvidence
        ? "BUY"
        : "SELL";
  const relevant = matched.filter((combination) => combination.direction === direction);
  const relevantPatterns = matchedPatterns.filter((pattern) => pattern.direction === direction);
  const best = relevant[0] ?? matched[0] ?? null;
  const bestPattern = relevantPatterns[0];
  const confidence = Math.round(
    Math.max(
      50,
      Math.min(
        95,
        ((best?.successRate ?? bestPattern?.successRate ?? 0.5) * 100 +
          (best?.confidenceHigh ?? bestPattern?.successRate ?? 0.5) * 100) /
          2,
      ),
    ),
  );
  const horizonMinutes = best?.holdingMinutes ?? 60;
  const stopFactor = direction === "SELL" ? 1.01 : 0.99;
  const targetFactor = direction === "SELL" ? 0.98 : 1.02;
  const stop =
    direction === "BUY"
      ? marketStructure.support ?? feature.close * stopFactor
      : marketStructure.resistance ?? feature.close * stopFactor;
  const target =
    direction === "BUY"
      ? marketStructure.resistance ?? feature.close * targetFactor
      : marketStructure.support ?? feature.close * targetFactor;
  const structureReasons = [
    marketStructure.support !== null
      ? `Поддержка: ${formatNumber(marketStructure.support)}`
      : null,
    marketStructure.resistance !== null
      ? `Сопротивление: ${formatNumber(marketStructure.resistance)}`
      : null,
    marketStructure.correlation !== null
      ? `Корреляция с IMOEX: ${formatNumber(marketStructure.correlation, 2)} ` +
        `(${marketStructure.correlationSamples ?? 0} наблюдений)`
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return {
    direction,
    confidence,
    reasons: [
      ...relevant.slice(0, 5).map(
      (combination) =>
        `${combination.name.replace(/^auto:/, "")}: ` +
        `${combination.occurrences} случаев, успех ${formatNumber((combination.successRate ?? 0) * 100, 1)}%, ` +
        `ожидаемо ${formatNumber(combination.expectedValue)}%`,
      ),
      ...relevantPatterns.slice(0, 3).map(
        (pattern) =>
          `Свечной паттерн ${pattern.name}: ${pattern.occurrences} случаев, ` +
          `успех ${formatNumber((pattern.successRate ?? 0) * 100, 1)}%`,
      ),
      ...structureReasons,
    ],
    stop,
    target,
    horizonMinutes,
    matched,
    matchedPatterns,
    marketStructure,
  };
}

function helpText() {
  return [
    "INVEST AI Research Engine",
    "",
    "Команды:",
    "/signal SBER — сигнал по тикеру",
    "/imoex — состав индекса IMOEX",
    "/market — состояние IMOEX",
    "/top — лучшие текущие сигналы",
    "/help — справка",
    "",
    "Данные: исторические свечи MOEX и рассчитанные признаки.",
  ].join("\n");
}

async function imoexText() {
  const rows = await db
    .select({
      ticker: moexTickers.secid,
      shortName: moexTickers.shortName,
    })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(asc(moexTickers.rank));

  if (!rows.length) {
    return "Состав IMOEX пока недоступен.";
  }

  return [
    `📋 Акции индекса IMOEX: ${rows.length}`,
    "",
    ...rows.map(
      (row, index) =>
        `${index + 1}. ${row.ticker}${row.shortName ? ` — ${row.shortName}` : ""}`,
    ),
    "",
    "Бот анализирует только этот список.",
  ].join("\n");
}

async function signalText(ticker: string) {
  const feature = await getLatestFeature(ticker);
  if (!feature) {
    const knownTicker = await db
      .select({ ticker: moexTickers.secid })
      .from(moexTickers)
      .where(eq(moexTickers.secid, ticker))
      .limit(1);
    return knownTicker.length
      ? `${ticker} сейчас не входит в активный состав IMOEX или по нему нет свежих данных.`
      : `${ticker} не входит в текущий состав IMOEX.\nСписок: /imoex`;
  }

  const analysis = await analyzeSignal(ticker, feature);
  const combinationIds = analysis.matched.map((combination) => combination.id);
  const patternIds = analysis.matchedPatterns.map((pattern) => pattern.id);
  await db.insert(signalsHistory).values({
    ticker,
    timeframe: TIMEFRAME,
    candleTimestamp: feature.timestamp,
    direction: analysis.direction,
    confidence: analysis.confidence,
    entryPrice: feature.close,
    stopPrice: analysis.stop,
    targetPrice: analysis.target,
    horizonMinutes: analysis.horizonMinutes,
    reasons: analysis.reasons,
    patternIds,
    combinationIds,
    metadata: {
      source: "telegram",
      validatedCombinations: combinationIds,
      validatedPatterns: patternIds,
      marketStructure: analysis.marketStructure,
    },
  });

  return [
    `📊 ${ticker}`,
    `Сигнал: ${directionLabel(analysis.direction)}`,
    `Уверенность: ${analysis.confidence}%`,
    `Цена: ${formatNumber(feature.close)}`,
    "",
    "Причины:",
    ...(analysis.reasons.length
      ? analysis.reasons.map((reason) => `• ${reason}`)
      : ["• недостаточно подтверждений"]),
    "",
    `Стоп: ${formatNumber(analysis.stop)}`,
    `Цель: ${formatNumber(analysis.target)}`,
    `Горизонт: ${analysis.horizonMinutes} минут`,
    `Свеча: ${formatDate(feature.timestamp)}`,
    "",
    "Важно: это статистический исследовательский сигнал, не финансовая рекомендация.",
  ].join("\n");
}

async function marketText() {
  const market = await getLatestMarket();
  if (!market) {
    return "Рыночный контекст IMOEX пока недоступен.";
  }
  const change = market.imoexChange ?? 0;
  const trend = change > 0.15 ? "восходящий" : change < -0.15 ? "нисходящий" : "боковой";
  const sign = change > 0 ? "+" : "";
  return [
    "📈 Состояние рынка",
    `IMOEX: ${formatNumber(market.imoexPrice)}`,
    `Изменение свечи: ${sign}${formatNumber(change)}%`,
    `Тренд: ${trend}`,
    `Обновлено: ${formatDate(market.timestamp)}`,
  ].join("\n");
}

async function topText() {
  const rows = await getTopRows();
  const context = await getSignalContext(
    rows
      .map((row) => row.historicalVolatility)
      .filter((value): value is number => value !== null),
  );
  const analyses = await Promise.all(
    rows.map(async (row) => ({
      row,
      analysis: await analyzeSignalWithContext(row.ticker, row, context),
    })),
  );
  const ranked = analyses
    .filter(
      ({ analysis }) =>
        analysis.direction !== "HOLD" &&
        (analysis.matched.length > 0 || analysis.matchedPatterns.length > 0),
    )
    .sort((left, right) => right.analysis.confidence - left.analysis.confidence)
    .slice(0, 10);

  if (!ranked.length) {
    return "Сейчас нет сигналов с достаточным подтверждением.";
  }

  return [
    "🔥 Лучшие текущие сигналы",
    "",
    ...ranked.map(
      ({ row, analysis }, index) =>
        `${index + 1}. ${row.ticker} ${analysis.direction} ${analysis.confidence}% · ${formatNumber(row.close)}`,
    ),
    "",
    "Для деталей: /signal ТИКЕР",
  ].join("\n");
}

async function handleMessage(chatId: number, text: string) {
  const trimmedText = text.trim();
  const [command, argument] = trimmedText.split(/\s+/, 2);
  const normalizedCommand = command.toLowerCase().split("@", 1)[0];
  const normalizedText = trimmedText.toLocaleLowerCase("ru-RU");

  if (normalizedCommand === "/start" || normalizedCommand === "/help") {
    return helpText();
  }
  if (normalizedText === "помощь") {
    return helpText();
  }
  if (normalizedCommand === "/imoex" || normalizedText === "состав") {
    return imoexText();
  }
  if (normalizedCommand === "/market") {
    return marketText();
  }
  if (normalizedText === "цены" || normalizedText === "котировка") {
    return marketText();
  }
  if (normalizedCommand === "/top") {
    return topText();
  }
  if (normalizedText === "акции" || normalizedText === "найденные") {
    return topText();
  }
  if (normalizedCommand === "/signal") {
    const ticker = argument?.toUpperCase().replace(/[^A-Z0-9_]/g, "");
    return ticker ? signalText(ticker) : "Укажите тикер: /signal SBER";
  }
  if (text.startsWith("/")) {
    return "Неизвестная команда. Используйте /help.";
  }
  return "Не понял сообщение. Нажмите «Помощь» или используйте /help.";
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createTelegramClient(token: string) {
  async function call<T>(
    method: string,
    params: Record<string, string | number | boolean | undefined> = {},
    signal?: AbortSignal,
  ) {
    const url = new URL(`${TELEGRAM_API}/bot${token}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { signal });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description ?? `Telegram API ${response.status}`);
    }
    return payload.result as T;
  }

  return {
    getMe: () => call<{ username?: string }>("getMe"),
    deleteWebhook: () => call<boolean>("deleteWebhook", { drop_pending_updates: false }),
    setMyCommands: (commands: string) =>
      call<boolean>("setMyCommands", { commands }),
    getUpdates: (offset: number, signal: AbortSignal) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: JSON.stringify(["message"]),
        },
        signal,
      ),
    sendMessage: (chatId: number, text: string) =>
      call("sendMessage", { chat_id: chatId, text }),
  };
}

export function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info("Telegram bot is disabled: TELEGRAM_BOT_TOKEN is not configured");
    return () => undefined;
  }

  let running = true;
  let offset = 0;
  const controller = new AbortController();
  const client = createTelegramClient(token);

  const stop = () => {
    running = false;
    controller.abort();
  };

  void (async () => {
    try {
      const me = await client.getMe();
      await client.deleteWebhook();
      await client.setMyCommands(
        JSON.stringify([
          { command: "signal", description: "Сигнал по тикеру" },
          { command: "imoex", description: "Состав индекса IMOEX" },
          { command: "market", description: "Состояние рынка" },
          { command: "top", description: "Лучшие сигналы" },
          { command: "help", description: "Справка" },
        ]),
      );
      logger.info({ username: me.username ?? "unknown" }, "Telegram bot connected");

      while (running) {
        try {
          const updates = await client.getUpdates(offset, controller.signal);
          if (updates.length > 0) {
            logger.info(
              { count: updates.length, firstUpdateId: updates[0]?.update_id },
              "Telegram updates received",
            );
          }
          for (const update of updates) {
            offset = update.update_id + 1;
            const message = update.message;
            if (!message?.text) continue;
            const command = message.text.trim().split(/\s+/, 1)[0];
            logger.info({ command }, "Telegram command received");
            try {
              const response = await handleMessage(message.chat.id, message.text);
              if (response) {
                await client.sendMessage(message.chat.id, response);
                logger.info({ command }, "Telegram response sent");
              }
            } catch (error) {
              logger.error({ err: error, command }, "Telegram command failed");
              await client.sendMessage(
                message.chat.id,
                "Не удалось обработать команду. Попробуйте ещё раз через несколько секунд.",
              );
            }
          }
        } catch (error) {
          if (!running) break;
          logger.error({ err: error }, "Telegram polling error; retrying");
          await sleep(3000);
        }
      }
    } catch (error) {
      if (running) {
        logger.error({ err: error }, "Telegram bot stopped with an error");
      }
    }
  })();

  return stop;
}