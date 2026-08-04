import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  detectedPatterns,
  patternStatistics,
  pool,
  signalsHistory,
} from "@workspace/db";
import { logger } from "./logger";

const TELEGRAM_API = "https://api.telegram.org";
const TIMEFRAME = "10m";
const POLL_TIMEOUT_SECONDS = 25;
const REFRESH_BUTTON = "🔄 Обновить исследование";
const SIGNAL_PICKER_BUTTON = "🎯 Сигнал по тикеру";
const AI_SCORE_WEIGHTS = {
  trend: 0.12,
  momentum: 0.1,
  volume: 0.06,
  pattern: 0.14,
  breakout: 0.05,
  smc: 0.05,
  structure: 0.08,
  correlation: 0.05,
  research: 0.16,
  backtest: 0.12,
  risk: 0.04,
  marketContext: 0.03,
} as const;
const RESEARCH_ENGINE_VERSION = "engine-1";
const TELEGRAM_MENU = {
  keyboard: [
    [REFRESH_BUTTON],
    [SIGNAL_PICKER_BUTTON],
    ["🔥 Лучшие сигналы", "📋 Состав IMOEX"],
    ["📈 Состояние рынка", "❓ Помощь"],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
let researchRefreshRunning = false;

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string; username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { first_name?: string; username?: string };
    message?: {
      chat: { id: number };
    };
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
  volume: number | null;
  avgVolume20: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  rsi: number | null;
  macdHist: number | null;
  relativeVolume: number | null;
  atr: number | null;
  vwap: number | null;
  bbMiddle: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  adx: number | null;
  stochasticRsi: number | null;
  cci: number | null;
  williamsR: number | null;
  mfi: number | null;
  obv: number | null;
  trendStrength: number | null;
  distanceToEma20: number | null;
  distanceToEma50: number | null;
  distanceToEma200: number | null;
  acceleration: number | null;
  priceChange3: number | null;
  priceChange5: number | null;
  bodySize: number | null;
  bodyToRange: number | null;
  upperShadow: number | null;
  lowerShadow: number | null;
  greenStreak: number | null;
  redStreak: number | null;
  candleRange: number | null;
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

type MacroSnapshot = {
  code: string;
  category: string;
  close: number | null;
  changePercent: number | null;
  timestamp: Date | null;
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
  profitFactor: number | null;
  bestTakeProfit: number | null;
  bestStopLoss: number | null;
  averageProfit: number | null;
  averageLoss: number | null;
  maxDrawdown: number | null;
  testWinRate: number | null;
  testExpectedValue: number | null;
  pValue: number | null;
  qValue: number | null;
  bestHoldingMinutes: number | null;
  sharpeRatio: number | null;
  trainWinRate: number | null;
  trainExpectedValue: number | null;
  testProfitFactor: number | null;
  statisticalSignificance: boolean;
};
type HistoricalEvidence = {
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  occurrences: number;
  averageProfit: number | null;
  averageLoss: number | null;
  maxDrawdown: number | null;
  bestTakeProfit: number | null;
  bestStopLoss: number | null;
  bestHoldingMinutes: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  pValue: number | null;
  qValue: number | null;
  testWinRate: number | null;
  testExpectancy: number | null;
  source: string;
};
type FactorThresholds = {
  rsiLow: number | null;
  rsiHigh: number | null;
  adxLow: number | null;
  adxHigh: number | null;
  atrPctLow: number | null;
  atrPctHigh: number | null;
  bbWidthLow: number | null;
  bbWidthHigh: number | null;
  volumeLow: number | null;
  volumeHigh: number | null;
  relativeVolumeLow: number | null;
  relativeVolumeHigh: number | null;
  accelerationLow: number | null;
  accelerationHigh: number | null;
  speedLow: number | null;
  speedHigh: number | null;
  rangePctLow: number | null;
  rangePctHigh: number | null;
  bodyPctLow: number | null;
  bodyPctHigh: number | null;
  upperShadowLow: number | null;
  upperShadowHigh: number | null;
  lowerShadowLow: number | null;
  lowerShadowHigh: number | null;
  volatilityLow: number | null;
  volatilityHigh: number | null;
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
type ProfessionalPattern = CandlePattern & {
  confidence: number;
  patternType: string;
  averageLoss: number | null;
  maxDrawdown: number | null;
  bestTakeProfit: number | null;
  bestStopLoss: number | null;
  bestHoldingMinutes: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
  pValue: number | null;
  qValue: number | null;
  trainWinRate: number | null;
  trainExpectancy: number | null;
  testWinRate: number | null;
  testExpectancy: number | null;
  expectancy: number | null;
};
type MarketStructure = {
  support: number | null;
  resistance: number | null;
  supportStrength: number | null;
  resistanceStrength: number | null;
  correlation: number | null;
  correlationSamples: number | null;
};
type SignalContext = {
  combinations: Combination[];
  volatilityMedian: number | null;
  thresholdsByTicker: Map<string, FactorThresholds>;
  patternsByTicker: Map<string, CandlePattern[]>;
  levelsByTicker: Map<
    string,
    { levelType: string; price: number; strength: number | null }[]
  >;
  correlationsByTicker: Map<
    string,
    { correlation: number | null; sampleCount: number | null }
  >;
  macro: MacroSnapshot[];
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
      volume: features.volume,
      avgVolume20: features.avgVolume20,
      ema20: features.ema20,
      ema50: features.ema50,
      ema100: features.ema100,
      ema200: features.ema200,
      rsi: features.rsi,
      macdHist: features.macdHist,
      relativeVolume: features.relativeVolume,
      atr: features.atr,
      vwap: features.vwap,
      bbMiddle: features.bbMiddle,
      bbUpper: features.bbUpper,
      bbLower: features.bbLower,
      bbWidth: features.bbWidth,
      adx: features.adx,
      stochasticRsi: features.stochasticRsi,
      cci: features.cci,
      williamsR: features.williamsR,
      mfi: features.mfi,
      obv: features.obv,
      trendStrength: features.trendStrength,
      distanceToEma20: features.distanceToEma20,
      distanceToEma50: features.distanceToEma50,
      distanceToEma200: features.distanceToEma200,
      acceleration: features.acceleration,
      priceChange3: features.priceChange3,
      priceChange5: features.priceChange5,
      bodySize: features.bodySize,
      bodyToRange: features.bodyToRange,
      upperShadow: features.upperShadow,
      lowerShadow: features.lowerShadow,
      greenStreak: features.greenStreak,
      redStreak: features.redStreak,
      candleRange: features.candleRange,
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
      f.volume,
      f.avg_volume_20 AS "avgVolume20",
      f.ema_20 AS "ema20",
      f.ema_50 AS "ema50",
      f.ema_100 AS "ema100",
      f.ema_200 AS "ema200",
      f.rsi,
      f.macd_hist AS "macdHist",
      f.relative_volume AS "relativeVolume",
      f.atr,
      f.vwap,
      f.bb_middle AS "bbMiddle",
      f.bb_upper AS "bbUpper",
      f.bb_lower AS "bbLower",
      f.bb_width AS "bbWidth",
      f.adx,
      f.stochastic_rsi AS "stochasticRsi",
      f.cci,
      f.williams_r AS "williamsR",
      f.mfi,
      f.obv,
      f.trend_strength AS "trendStrength",
      f.distance_to_ema_20 AS "distanceToEma20",
      f.distance_to_ema_50 AS "distanceToEma50",
      f.distance_to_ema_200 AS "distanceToEma200",
      f.acceleration,
      f.price_change_3 AS "priceChange3",
      f.price_change_5 AS "priceChange5",
      f.body_size AS "bodySize",
      f.body_to_range AS "bodyToRange",
      f.upper_shadow AS "upperShadow",
      f.lower_shadow AS "lowerShadow",
      f.green_streak AS "greenStreak",
      f.red_streak AS "redStreak",
      f.candle_range AS "candleRange",
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
        f.volume,
        f.avg_volume_20,
        f.ema_20,
        f.ema_50,
        f.ema_100,
        f.ema_200,
        f.rsi,
        f.macd_hist,
        f.relative_volume,
        f.atr,
        f.vwap,
        f.bb_middle,
        f.bb_upper,
        f.bb_lower,
        f.bb_width,
        f.adx,
        f.stochastic_rsi,
        f.cci,
        f.williams_r,
        f.mfi,
        f.obv,
        f.trend_strength,
        f.distance_to_ema_20,
        f.distance_to_ema_50,
        f.distance_to_ema_200,
        f.acceleration,
        f.price_change_3,
        f.price_change_5,
        f.body_size,
        f.body_to_range,
        f.upper_shadow,
        f.lower_shadow,
        f.green_streak,
        f.red_streak,
        f.candle_range,
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
  return (result.rows as unknown as TopRow[]).map((row) => ({
    ...row,
    timestamp:
      row.timestamp instanceof Date
        ? row.timestamp
        : new Date(row.timestamp as unknown as string),
  }));
}

async function getValidatedCombinations(): Promise<Combination[]> {
  const result = await db
    .select({
      id: featureCombinations.id,
      name: featureCombinations.name,
      conditions: featureCombinations.conditions,
      direction: featureCombinations.direction,
      successRate: featureCombinations.successRate,
      profitFactor: featureCombinations.profitFactor,
      expectedValue: featureCombinations.expectedValue,
      occurrences: featureCombinations.occurrences,
      holdingMinutes: featureCombinations.holdingMinutes,
      confidenceLow: featureCombinations.confidenceLow,
      confidenceHigh: featureCombinations.confidenceHigh,
      bestTakeProfit: featureCombinations.bestTakeProfit,
      bestStopLoss: featureCombinations.bestStopLoss,
      averageProfit: featureCombinations.averageProfit,
      averageLoss: featureCombinations.averageLoss,
      maxDrawdown: featureCombinations.maxDrawdown,
      testWinRate: featureCombinations.testWinRate,
      testExpectedValue: featureCombinations.testExpectedValue,
      pValue: featureCombinations.pValue,
      sharpeRatio: sql<number | null>`
        (
          SELECT sr.sharpe_ratio
          FROM strategy_results sr
          WHERE sr.name = ${featureCombinations.name}
            AND sr.version = ${RESEARCH_ENGINE_VERSION}
          LIMIT 1
        )
      `,
      trainWinRate: sql<number | null>`
        (
          SELECT sr.train_win_rate
          FROM strategy_results sr
          WHERE sr.name = ${featureCombinations.name}
            AND sr.version = ${RESEARCH_ENGINE_VERSION}
          LIMIT 1
        )
      `,
      trainExpectedValue: sql<number | null>`
        (
          SELECT sr.train_expected_value
          FROM strategy_results sr
          WHERE sr.name = ${featureCombinations.name}
            AND sr.version = ${RESEARCH_ENGINE_VERSION}
          LIMIT 1
        )
      `,
      testProfitFactor: sql<number | null>`
        (
          SELECT sr.test_profit_factor
          FROM strategy_results sr
          WHERE sr.name = ${featureCombinations.name}
            AND sr.version = ${RESEARCH_ENGINE_VERSION}
          LIMIT 1
        )
      `,
      qValue: sql<number | null>`
        (
          SELECT NULLIF(sr.metadata ->> 'qValue', '')::double precision
          FROM strategy_results sr
          WHERE sr.name = ${featureCombinations.name}
            AND sr.version = 'engine-1'
          LIMIT 1
        )
      `,
      bestHoldingMinutes: featureCombinations.bestHoldingMinutes,
      statisticalSignificance: featureCombinations.statisticalSignificance,
    })
    .from(featureCombinations)
    .where(
      and(
        eq(featureCombinations.isActive, true),
        eq(featureCombinations.statisticalSignificance, true),
        gte(featureCombinations.occurrences, 30),
        sql`${featureCombinations.successRate} >= 0.55`,
        sql`${featureCombinations.profitFactor} > 1.2`,
        sql`${featureCombinations.name} LIKE 'auto-engine:%'`,
      ),
    )
    .orderBy(desc(featureCombinations.expectedValue));
  return result as Combination[];
}

async function getLatestMacroContext(): Promise<MacroSnapshot[]> {
  const result = await db.execute(sql`
    SELECT
      mi.code,
      mi.category,
      mo.close,
      mo.change_percent AS "changePercent",
      mo.timestamp
    FROM market_instruments mi
    INNER JOIN LATERAL (
      SELECT close, change_percent, timestamp
      FROM market_observations
      WHERE instrument_id = mi.id
      ORDER BY timestamp DESC
      LIMIT 1
    ) mo ON true
    WHERE mi.is_active = true
    ORDER BY mi.category, mi.code
  `);
  return (result.rows as unknown as MacroSnapshot[]).map((row) => ({
    ...row,
    timestamp:
      row.timestamp instanceof Date
        ? row.timestamp
        : row.timestamp
          ? new Date(row.timestamp as unknown as string)
          : null,
  }));
}

function matchesCombination(
  feature: LatestFeature,
  combination: Combination,
  thresholds: FactorThresholds | undefined,
  professionalPatternKeys: Set<string>,
) {
  if (!thresholds) return false;
  const percentage = (value: number | null, base: number | null) =>
    value !== null && base !== null && Number.isFinite(value) && Number.isFinite(base) && base !== 0
      ? (value / base) * 100
      : null;
  const between = (value: number | null, low: number | null, high: number | null) =>
    value !== null && low !== null && high !== null && value >= low && value <= high;
  return combination.conditions.every((condition) => {
    const key = String(condition.key ?? "");
    switch (key) {
      case "price_above_ema20":
        return feature.ema20 !== null && feature.close > feature.ema20;
      case "price_below_ema20":
        return feature.ema20 !== null && feature.close < feature.ema20;
      case "ema20_above_ema50":
        return feature.ema20 !== null && feature.ema50 !== null && feature.ema20 > feature.ema50;
      case "ema20_below_ema50":
        return feature.ema20 !== null && feature.ema50 !== null && feature.ema20 < feature.ema50;
      case "ema50_above_ema200":
        return feature.ema50 !== null && feature.ema200 !== null && feature.ema50 > feature.ema200;
      case "ema50_below_ema200":
        return feature.ema50 !== null && feature.ema200 !== null && feature.ema50 < feature.ema200;
      case "rsi_low":
        return feature.rsi !== null && thresholds.rsiLow !== null && feature.rsi <= thresholds.rsiLow;
      case "rsi_high":
        return feature.rsi !== null && thresholds.rsiHigh !== null && feature.rsi >= thresholds.rsiHigh;
      case "macd_positive":
        return feature.macdHist !== null && feature.macdHist > 0;
      case "macd_negative":
        return feature.macdHist !== null && feature.macdHist < 0;
      case "adx_high":
        return feature.adx !== null && thresholds.adxHigh !== null && feature.adx >= thresholds.adxHigh;
      case "adx_low":
        return feature.adx !== null && thresholds.adxLow !== null && feature.adx <= thresholds.adxLow;
      case "atr_high": {
        const value = percentage(feature.atr, feature.close);
        return value !== null && thresholds.atrPctHigh !== null && value >= thresholds.atrPctHigh;
      }
      case "atr_low": {
        const value = percentage(feature.atr, feature.close);
        return value !== null && thresholds.atrPctLow !== null && value <= thresholds.atrPctLow;
      }
      case "above_vwap":
        return feature.vwap !== null && feature.close > feature.vwap;
      case "below_vwap":
        return feature.vwap !== null && feature.close < feature.vwap;
      case "bollinger_low":
        return feature.bbLower !== null && feature.close <= feature.bbLower;
      case "bollinger_high":
        return feature.bbUpper !== null && feature.close >= feature.bbUpper;
      case "bollinger_squeeze":
        return feature.bbWidth !== null && thresholds.bbWidthLow !== null && feature.bbWidth <= thresholds.bbWidthLow;
      case "bollinger_expansion":
        return feature.bbWidth !== null && thresholds.bbWidthHigh !== null && feature.bbWidth >= thresholds.bbWidthHigh;
      case "volume_high":
        return feature.volume !== null && thresholds.volumeHigh !== null && feature.volume >= thresholds.volumeHigh;
      case "relative_volume_high":
        return feature.relativeVolume !== null && thresholds.relativeVolumeHigh !== null && feature.relativeVolume >= thresholds.relativeVolumeHigh;
      case "relative_volume_low":
        return feature.relativeVolume !== null && thresholds.relativeVolumeLow !== null && feature.relativeVolume <= thresholds.relativeVolumeLow;
      case "acceleration_high":
        return feature.acceleration !== null && thresholds.accelerationHigh !== null && feature.acceleration >= thresholds.accelerationHigh;
      case "acceleration_low":
        return feature.acceleration !== null && thresholds.accelerationLow !== null && feature.acceleration <= thresholds.accelerationLow;
      case "speed_high": {
        const value = feature.priceChange5 ?? feature.priceChange3;
        return value !== null && thresholds.speedHigh !== null && value >= thresholds.speedHigh;
      }
      case "speed_low": {
        const value = feature.priceChange5 ?? feature.priceChange3;
        return value !== null && thresholds.speedLow !== null && value <= thresholds.speedLow;
      }
      case "large_candle": {
        const value = percentage(feature.candleRange, feature.close);
        return value !== null && thresholds.rangePctHigh !== null && value >= thresholds.rangePctHigh;
      }
      case "small_candle": {
        const value = percentage(feature.candleRange, feature.close);
        return value !== null && thresholds.rangePctLow !== null && value <= thresholds.rangePctLow;
      }
      case "large_body": {
        const value = percentage(feature.bodySize, feature.close);
        return value !== null && thresholds.bodyPctHigh !== null && value >= thresholds.bodyPctHigh;
      }
      case "upper_shadow_high": {
        const value = percentage(feature.upperShadow, feature.candleRange);
        return value !== null && thresholds.upperShadowHigh !== null && value >= thresholds.upperShadowHigh;
      }
      case "lower_shadow_high": {
        const value = percentage(feature.lowerShadow, feature.candleRange);
        return value !== null && thresholds.lowerShadowHigh !== null && value >= thresholds.lowerShadowHigh;
      }
      case "green_series":
        return (feature.greenStreak ?? 0) >= 3;
      case "red_series":
        return (feature.redStreak ?? 0) >= 3;
      case "volatility_high":
        return feature.historicalVolatility !== null && thresholds.volatilityHigh !== null && feature.historicalVolatility >= thresholds.volatilityHigh;
      case "volatility_low":
        return feature.historicalVolatility !== null && thresholds.volatilityLow !== null && feature.historicalVolatility <= thresholds.volatilityLow;
      default:
        if (key.startsWith("pattern:")) {
          return professionalPatternKeys.has(key.slice("pattern:".length));
        }
        return false;
    }
  });
}

async function getCurrentProfessionalPatterns(
  ticker: string,
  timestamp: Date,
): Promise<ProfessionalPattern[]> {
  const result = await db
    .select({
      id: detectedPatterns.id,
      name: detectedPatterns.patternType,
      patternType: detectedPatterns.patternType,
      direction: detectedPatterns.direction,
      confidence: detectedPatterns.confidence,
      successRate: patternStatistics.winRate,
      profitFactor: patternStatistics.profitFactor,
      occurrences: patternStatistics.occurrences,
      averageProfit: patternStatistics.averageProfit,
      averageLoss: patternStatistics.averageLoss,
      maxDrawdown: patternStatistics.maxDrawdown,
      bestTakeProfit: patternStatistics.bestTakeProfit,
      bestStopLoss: patternStatistics.bestStopLoss,
      bestHoldingMinutes: patternStatistics.bestHoldingMinutes,
      confidenceLow: patternStatistics.confidenceLow,
      confidenceHigh: patternStatistics.confidenceHigh,
      pValue: patternStatistics.pValue,
      qValue: patternStatistics.qValue,
      trainWinRate: patternStatistics.trainWinRate,
      trainExpectancy: patternStatistics.trainExpectancy,
      testWinRate: patternStatistics.testWinRate,
      testExpectancy: patternStatistics.testExpectancy,
      expectancy: patternStatistics.expectancy,
    })
    .from(detectedPatterns)
    .innerJoin(
      patternStatistics,
      and(
        eq(patternStatistics.ticker, detectedPatterns.ticker),
        eq(patternStatistics.timeframe, detectedPatterns.timeframe),
        eq(patternStatistics.patternType, detectedPatterns.patternType),
        eq(patternStatistics.direction, detectedPatterns.direction),
      ),
    )
    .where(
      and(
        eq(detectedPatterns.ticker, ticker),
        eq(detectedPatterns.timeframe, TIMEFRAME),
        eq(detectedPatterns.endTimestamp, timestamp),
        eq(patternStatistics.isSignificant, true),
      ),
    )
    .orderBy(desc(patternStatistics.winRate));
  return result as ProfessionalPattern[];
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getFactorThresholds(): Promise<Map<string, FactorThresholds>> {
  const result = await db.execute(sql`
    SELECT f.ticker,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.rsi) FILTER (WHERE f.rsi IS NOT NULL) AS rsi_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.rsi) FILTER (WHERE f.rsi IS NOT NULL) AS rsi_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.adx) FILTER (WHERE f.adx IS NOT NULL) AS adx_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.adx) FILTER (WHERE f.adx IS NOT NULL) AS adx_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.atr / NULLIF(c.close, 0) * 100) FILTER (WHERE f.atr IS NOT NULL AND c.close <> 0) AS atr_pct_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.atr / NULLIF(c.close, 0) * 100) FILTER (WHERE f.atr IS NOT NULL AND c.close <> 0) AS atr_pct_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.bb_width) FILTER (WHERE f.bb_width IS NOT NULL) AS bb_width_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.bb_width) FILTER (WHERE f.bb_width IS NOT NULL) AS bb_width_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.volume) FILTER (WHERE f.volume IS NOT NULL) AS volume_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.volume) FILTER (WHERE f.volume IS NOT NULL) AS volume_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.relative_volume) FILTER (WHERE f.relative_volume IS NOT NULL) AS relative_volume_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.relative_volume) FILTER (WHERE f.relative_volume IS NOT NULL) AS relative_volume_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.acceleration) FILTER (WHERE f.acceleration IS NOT NULL) AS acceleration_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.acceleration) FILTER (WHERE f.acceleration IS NOT NULL) AS acceleration_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY COALESCE(f.price_change_5, f.price_change_3)) FILTER (WHERE COALESCE(f.price_change_5, f.price_change_3) IS NOT NULL) AS speed_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY COALESCE(f.price_change_5, f.price_change_3)) FILTER (WHERE COALESCE(f.price_change_5, f.price_change_3) IS NOT NULL) AS speed_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.candle_range / NULLIF(c.close, 0) * 100) FILTER (WHERE f.candle_range IS NOT NULL AND c.close <> 0) AS range_pct_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.candle_range / NULLIF(c.close, 0) * 100) FILTER (WHERE f.candle_range IS NOT NULL AND c.close <> 0) AS range_pct_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.body_size / NULLIF(c.close, 0) * 100) FILTER (WHERE f.body_size IS NOT NULL AND c.close <> 0) AS body_pct_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.body_size / NULLIF(c.close, 0) * 100) FILTER (WHERE f.body_size IS NOT NULL AND c.close <> 0) AS body_pct_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.upper_shadow / NULLIF(f.candle_range, 0) * 100) FILTER (WHERE f.upper_shadow IS NOT NULL AND f.candle_range <> 0) AS upper_shadow_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.upper_shadow / NULLIF(f.candle_range, 0) * 100) FILTER (WHERE f.upper_shadow IS NOT NULL AND f.candle_range <> 0) AS upper_shadow_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.lower_shadow / NULLIF(f.candle_range, 0) * 100) FILTER (WHERE f.lower_shadow IS NOT NULL AND f.candle_range <> 0) AS lower_shadow_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.lower_shadow / NULLIF(f.candle_range, 0) * 100) FILTER (WHERE f.lower_shadow IS NOT NULL AND f.candle_range <> 0) AS lower_shadow_high,
      percentile_cont(0.2) WITHIN GROUP (ORDER BY f.historical_volatility) FILTER (WHERE f.historical_volatility IS NOT NULL) AS volatility_low,
      percentile_cont(0.8) WITHIN GROUP (ORDER BY f.historical_volatility) FILTER (WHERE f.historical_volatility IS NOT NULL) AS volatility_high
    FROM features f
    INNER JOIN candles c ON c.ticker = f.ticker AND c.timestamp = f.timestamp AND c.timeframe = ${TIMEFRAME}
    INNER JOIN moex_tickers t ON t.secid = f.ticker AND t.is_active = true
    GROUP BY f.ticker
  `);
  const thresholds = new Map<string, FactorThresholds>();
  for (const row of result.rows) {
    const value = (key: string) => numberOrNull((row as Record<string, unknown>)[key]);
    thresholds.set(String((row as { ticker: string }).ticker), {
      rsiLow: value("rsi_low"), rsiHigh: value("rsi_high"),
      adxLow: value("adx_low"), adxHigh: value("adx_high"),
      atrPctLow: value("atr_pct_low"), atrPctHigh: value("atr_pct_high"),
      bbWidthLow: value("bb_width_low"), bbWidthHigh: value("bb_width_high"),
      volumeLow: value("volume_low"), volumeHigh: value("volume_high"),
      relativeVolumeLow: value("relative_volume_low"), relativeVolumeHigh: value("relative_volume_high"),
      accelerationLow: value("acceleration_low"), accelerationHigh: value("acceleration_high"),
      speedLow: value("speed_low"), speedHigh: value("speed_high"),
      rangePctLow: value("range_pct_low"), rangePctHigh: value("range_pct_high"),
      bodyPctLow: value("body_pct_low"), bodyPctHigh: value("body_pct_high"),
      upperShadowLow: value("upper_shadow_low"), upperShadowHigh: value("upper_shadow_high"),
      lowerShadowLow: value("lower_shadow_low"), lowerShadowHigh: value("lower_shadow_high"),
      volatilityLow: value("volatility_low"), volatilityHigh: value("volatility_high"),
    });
  }
  return thresholds;
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
    .map((level) => ({ price: level.price, strength: level.strength }))
    .filter((level) => Number.isFinite(level.price) && level.price <= currentPrice);
  const resistances = levels
    .filter((level) => level.levelType === "resistance")
    .map((level) => ({ price: level.price, strength: level.strength }))
    .filter((level) => Number.isFinite(level.price) && level.price >= currentPrice);
  const correlation = context.correlationsByTicker.get(ticker);
  return {
    support: supports.length ? Math.max(...supports.map((level) => level.price)) : null,
    resistance: resistances.length ? Math.min(...resistances.map((level) => level.price)) : null,
    supportStrength: supports.length
      ? Math.max(...supports.map((level) => level.strength ?? 0))
      : null,
    resistanceStrength: resistances.length
      ? Math.max(...resistances.map((level) => level.strength ?? 0))
      : null,
    correlation: correlation?.correlation ?? null,
    correlationSamples: correlation?.sampleCount ?? null,
  };
}

async function getSignalContext(volatilityValues: number[] = []): Promise<SignalContext> {
  if (cachedSignalContext && cachedSignalContext.expiresAt > Date.now()) {
    return cachedSignalContext.value;
  }
  const [combinations, patternRows, levelRows, correlationRows, thresholdsByTicker, macro] =
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
          strength: marketLevels.strength,
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
      getFactorThresholds(),
      getLatestMacroContext(),
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
    { levelType: string; price: number; strength: number | null }[]
  >();
  for (const level of levelRows) {
    const current = levelsByTicker.get(level.ticker) ?? [];
    current.push({
      levelType: level.levelType,
      price: level.price,
      strength: level.strength,
    });
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
    thresholdsByTicker,
    patternsByTicker,
    levelsByTicker,
    correlationsByTicker,
    macro,
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
  matchedPatterns: ProfessionalPattern[];
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
  matchedPatterns: ProfessionalPattern[];
  marketStructure: MarketStructure;
}> {
  const combinations = context.combinations;
  const thresholds = context.thresholdsByTicker.get(ticker);
  const marketStructure = marketStructureFromContext(
    ticker,
    feature.close,
    context,
  );
  const matchedPatterns = await getCurrentProfessionalPatterns(ticker, feature.timestamp);
  const professionalPatternKeys = new Set(
    matchedPatterns.map((pattern) => `${pattern.patternType}:${pattern.direction}`),
  );
  const matched = combinations.filter((combination) =>
    matchesCombination(feature, combination, thresholds, professionalPatternKeys),
  );
  if (!matched.length) {
    return {
      direction: "HOLD" as SignalDirection,
      confidence: 50,
      reasons: ["Нет совпадения с подтверждённой исторической закономерностью"],
      stop: feature.close * 0.99,
      target: feature.close * 1.01,
      horizonMinutes: 60,
      matched: [] as Combination[],
      matchedPatterns: [] as ProfessionalPattern[],
      marketStructure,
    };
  }

  const buyEvidence = matched
    .filter((combination) => combination.direction === "BUY")
    .reduce((sum, combination) => sum + Math.max(combination.expectedValue ?? 0, 0), 0);
  const sellEvidence = matched
    .filter((combination) => combination.direction === "SELL")
    .reduce((sum, combination) => sum + Math.max(combination.expectedValue ?? 0, 0), 0);
  const totalBuyEvidence = buyEvidence;
  const totalSellEvidence = sellEvidence;
  const direction: SignalDirection =
    totalBuyEvidence === totalSellEvidence
      ? "HOLD"
      : totalBuyEvidence > totalSellEvidence
        ? "BUY"
        : "SELL";
  const relevant = matched.filter((combination) => combination.direction === direction);
  const relevantPatterns = matchedPatterns.filter((pattern) => pattern.direction === direction);
  const bestCombination = relevant[0] ?? matched[0] ?? null;
  const bestHistorical =
    topEvidence({
      direction,
      confidence: 50,
      reasons: [],
      stop: feature.close,
      target: feature.close,
      horizonMinutes: 0,
      matched,
      matchedPatterns,
      marketStructure,
    }) ?? bestCombination;
  const historicalConfidenceHigh =
    bestHistorical && "confidenceHigh" in bestHistorical
      ? bestHistorical.confidenceHigh
      : null;
  const historicalTestWinRate =
    bestHistorical && "testWinRate" in bestHistorical
      ? bestHistorical.testWinRate
      : null;
  const confidence = Math.round(
    Math.max(
      50,
      Math.min(
        95,
        ((bestHistorical?.successRate ?? 0.5) * 100 +
          (historicalConfidenceHigh ?? historicalTestWinRate ?? 0.5) *
            100) /
          2,
      ),
    ),
  );
  const horizonMinutes =
    bestHistorical.bestHoldingMinutes ?? 60;
  const bestTakeProfit = bestHistorical?.bestTakeProfit;
  const bestStopLoss = bestHistorical?.bestStopLoss;
  const takeProfitPrice =
    bestTakeProfit !== null && bestTakeProfit !== undefined
      ? direction === "BUY"
        ? feature.close * (1 + bestTakeProfit / 100)
        : feature.close * (1 - bestTakeProfit / 100)
      : null;
  const stopLossPrice =
    bestStopLoss !== null && bestStopLoss !== undefined
      ? direction === "BUY"
        ? feature.close * (1 - bestStopLoss / 100)
        : feature.close * (1 + bestStopLoss / 100)
      : null;
  const stop =
    stopLossPrice ??
    (direction === "BUY"
      ? marketStructure.support ?? feature.close * 0.99
      : marketStructure.resistance ?? feature.close * 1.01);
  const target =
    takeProfitPrice ??
    (direction === "BUY"
      ? marketStructure.resistance ?? feature.close * 1.02
      : marketStructure.support ?? feature.close * 0.98);
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

type TopCandidate = {
  row: TopRow;
  analysis: Awaited<ReturnType<typeof analyzeSignalWithContext>>;
  rating: number;
  evidence: Combination | ProfessionalPattern | null;
  confirmations: string[];
  matchedFactorCount: number;
  scoreBlocks: ScoreBlocks;
  matchedPatterns: string[];
  matchedFactors: string[];
  backtest: Combination | null;
};

type ScoreBlocks = {
  trend: number | null;
  momentum: number | null;
  volume: number | null;
  pattern: number | null;
  breakout: number | null;
  smc: number | null;
  structure: number | null;
  correlation: number | null;
  research: number | null;
  backtest: number | null;
  risk: number | null;
  marketContext: number | null;
};

type BacktestEvidence = Combination;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, value));
}

function directionAgreement(direction: SignalDirection, value: number | null) {
  if (value === null || !Number.isFinite(value) || direction === "HOLD") return null;
  const signed = direction === "BUY" ? value : -value;
  return clampScore(50 + signed * 50);
}

function macroPressure(macro: MacroSnapshot[]) {
  const indexChanges = macro
    .filter((item) => item.code === "IMOEX" || item.code === "RTSI")
    .map((item) => item.changePercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return indexChanges.length
    ? indexChanges.reduce((sum, value) => sum + value, 0) / indexChanges.length
    : null;
}

function getBacktestEvidence(
  analysis: Awaited<ReturnType<typeof analyzeSignalWithContext>>,
): BacktestEvidence | null {
  return (
    analysis.matched
      .filter(
        (combination) =>
          combination.direction === analysis.direction &&
          combination.testExpectedValue !== null &&
          combination.testExpectedValue > 0 &&
          combination.testWinRate !== null &&
          combination.testWinRate >= 0.55 &&
          combination.testProfitFactor !== null &&
          combination.testProfitFactor > 1,
      )
      .sort(
        (left, right) =>
          (right.testExpectedValue ?? -Infinity) - (left.testExpectedValue ?? -Infinity),
      )[0] ?? null
  );
}

function scoreBlocks(
  row: TopRow,
  analysis: Awaited<ReturnType<typeof analyzeSignalWithContext>>,
  context: SignalContext,
  evidence: Combination | ProfessionalPattern | null,
  backtest: BacktestEvidence | null,
): ScoreBlocks {
  const bullish = analysis.direction === "BUY";
  const trend =
    row.ema20 !== null && row.ema50 !== null && row.ema200 !== null
      ? clampScore(
          50 +
            (bullish
              ? (row.ema20 > row.ema50 ? 20 : -20) +
                (row.ema50 > row.ema200 ? 20 : -20)
              : (row.ema20 < row.ema50 ? 20 : -20) +
                (row.ema50 < row.ema200 ? 20 : -20)) +
            (row.adx !== null ? Math.min(20, Math.max(0, row.adx - 20)) : 0),
        )
      : null;
  const momentumValues = [
    row.macdHist !== null ? (bullish ? Math.sign(row.macdHist) : -Math.sign(row.macdHist)) : null,
    row.acceleration !== null
      ? (bullish ? Math.sign(row.acceleration) : -Math.sign(row.acceleration))
      : null,
    row.priceChange5 !== null
      ? (bullish ? Math.sign(row.priceChange5) : -Math.sign(row.priceChange5))
      : null,
  ].filter((value): value is number => value !== null);
  const momentum =
    momentumValues.length
      ? clampScore(50 + (momentumValues.reduce((sum, value) => sum + value, 0) / momentumValues.length) * 50)
      : null;
  const volume =
    row.relativeVolume !== null
      ? clampScore(50 + Math.max(-1, Math.min(1, row.relativeVolume - 1)) * 50)
      : null;
  const patternValues = analysis.matchedPatterns
    .filter((pattern) => pattern.direction === analysis.direction)
    .map((pattern) => {
      const winRate = pattern.successRate ?? 0;
      const testWinRate = pattern.testWinRate ?? winRate;
      return (winRate + testWinRate) * 50;
    });
  const pattern = patternValues.length
    ? clampScore(patternValues.reduce((sum, value) => sum + value, 0) / patternValues.length)
    : null;
  const breakout =
    row.bbUpper !== null && row.bbLower !== null && row.bbUpper !== row.bbLower
      ? clampScore(
          bullish
            ? ((row.close - row.bbLower) / (row.bbUpper - row.bbLower)) * 100
            : ((row.bbUpper - row.close) / (row.bbUpper - row.bbLower)) * 100,
        )
      : null;
  const smcNames = analysis.matchedPatterns.filter((pattern) =>
    /BOS|CHOCH|Liquidity|Order Block|Breaker|Mitigation|Fair Value|Imbalance|Premium|Discount/i.test(
      pattern.patternType,
    ),
  );
  const smc = smcNames.length
    ? clampScore(
        smcNames.reduce(
          (sum, pattern) => sum + (pattern.successRate ?? 0.5) * 100,
          0,
        ) / smcNames.length,
      )
    : null;
  const distanceToSupport =
    analysis.marketStructure.support !== null
      ? Math.abs(row.close - analysis.marketStructure.support) / row.close
      : null;
  const distanceToResistance =
    analysis.marketStructure.resistance !== null
      ? Math.abs(row.close - analysis.marketStructure.resistance) / row.close
      : null;
  const structure =
    analysis.marketStructure.support !== null || analysis.marketStructure.resistance !== null
      ? clampScore(
          50 +
            (bullish
              ? (distanceToSupport !== null && distanceToSupport < 0.02 ? 25 : 0)
              : (distanceToResistance !== null && distanceToResistance < 0.02 ? 25 : 0)) +
            Math.max(
              analysis.marketStructure.supportStrength ?? 0,
              analysis.marketStructure.resistanceStrength ?? 0,
            ),
        )
      : null;
  const correlation =
    analysis.marketStructure.correlation !== null
      ? directionAgreement(analysis.direction, analysis.marketStructure.correlation)
      : null;
  const expectancy = evidence
    ? "expectancy" in evidence
      ? evidence.expectancy
      : evidence.expectedValue
    : null;
  const research = evidence
    ? clampScore(
        (evidence.successRate ?? 0) * 55 +
          Math.min(35, (evidence.profitFactor ?? 0) * 15) +
          Math.max(0, Math.min(10, (expectancy ?? 0) * 10)),
      )
    : null;
  const backtestScore = backtest
    ? clampScore(
        (backtest.testWinRate ?? 0) * 55 +
          Math.min(30, (backtest.testProfitFactor ?? 0) * 15) +
          Math.max(0, Math.min(15, (backtest.testExpectedValue ?? 0) * 10)),
      )
    : null;
  const risk =
    row.atr !== null && row.close > 0
      ? clampScore(100 - Math.min(100, (row.atr / row.close) * 100 * 20))
      : null;
  const pressure = macroPressure(context.macro);
  const marketContext =
    pressure !== null
      ? clampScore(50 + (bullish ? pressure : -pressure) * 20)
      : null;
  return {
    trend,
    momentum,
    volume,
    pattern,
    breakout,
    smc,
    structure,
    correlation,
    research,
    backtest: backtestScore,
    risk,
    marketContext,
  };
}

function weightedScore(blocks: ScoreBlocks) {
  const entries = Object.entries(AI_SCORE_WEIGHTS) as [
    keyof typeof AI_SCORE_WEIGHTS,
    number,
  ][];
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of entries) {
    const value = blocks[key];
    if (value === null || !Number.isFinite(value)) continue;
    weighted += value * weight;
    totalWeight += weight;
  }
  return totalWeight ? Math.round(weighted / totalWeight) : 0;
}

function evidenceScore(evidence: Combination | ProfessionalPattern) {
  const winRate = evidence.successRate ?? 0;
  const expectancy =
    "expectancy" in evidence
      ? evidence.expectancy ?? 0
      : evidence.expectedValue ?? 0;
  const profitFactor = evidence.profitFactor ?? 0;
  const occurrences = evidence.occurrences ?? 0;
  const testWinRate =
    "testWinRate" in evidence ? evidence.testWinRate ?? winRate : winRate;
  return (
    expectancy * 10 +
    profitFactor * 2 +
    winRate * 50 +
    testWinRate * 30 +
    Math.log1p(occurrences)
  );
}

function topEvidence(
  analysis: Awaited<ReturnType<typeof analyzeSignalWithContext>>,
): Combination | ProfessionalPattern | null {
  const directionEvidence = [
    ...analysis.matched.filter(
      (combination) => combination.direction === analysis.direction,
    ),
    ...analysis.matchedPatterns.filter(
      (pattern) => pattern.direction === analysis.direction,
    ),
  ].filter(
    (evidence) =>
      Number(evidence.bestTakeProfit) > 0 &&
      Number(evidence.bestStopLoss) > 0,
  );
  return (
    directionEvidence.sort((left, right) => evidenceScore(right) - evidenceScore(left))[0] ??
    null
  );
}

function topConfirmations(
  row: TopRow,
  analysis: Awaited<ReturnType<typeof analyzeSignalWithContext>>,
) {
  const confirmations: string[] = [];
  const direction = analysis.direction;
  const bullish = direction === "BUY";
  if (
    row.ema20 !== null &&
    row.ema50 !== null &&
    row.ema200 !== null &&
    ((bullish && row.ema20 > row.ema50 && row.ema50 > row.ema200) ||
      (!bullish && row.ema20 < row.ema50 && row.ema50 < row.ema200))
  ) {
    confirmations.push("EMA20/50/200 подтверждает тренд");
  }
  if (
    row.rsi !== null &&
    ((bullish && row.rsi < 45) || (!bullish && row.rsi > 55))
  ) {
    confirmations.push(`RSI подтверждает направление (${formatNumber(row.rsi, 1)})`);
  }
  if (
    row.macdHist !== null &&
    ((bullish && row.macdHist > 0) || (!bullish && row.macdHist < 0))
  ) {
    confirmations.push("MACD подтверждает направление");
  }
  if (row.adx !== null && row.adx >= 20) {
    confirmations.push(`ADX показывает тренд (${formatNumber(row.adx, 1)})`);
  }
  if (row.relativeVolume !== null && row.relativeVolume >= 1.2) {
    confirmations.push(
      `относительный объём выше среднего (${formatNumber(row.relativeVolume, 2)}x)`,
    );
  }
  if (
    analysis.marketStructure.support !== null ||
    analysis.marketStructure.resistance !== null
  ) {
    confirmations.push("рядом есть исторический уровень");
  }
  if (analysis.marketStructure.correlation !== null) {
    confirmations.push(
      `корреляция с IMOEX ${formatNumber(analysis.marketStructure.correlation, 2)}`,
    );
  }
  return [
    ...confirmations,
    `${analysis.matched.length} исторических комбинаций факторов`,
    `${analysis.matchedPatterns.length} подтверждённых паттернов`,
  ];
}

async function getTopAnalysisStats() {
  const result = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM moex_tickers WHERE is_active = true AND secid <> 'IMOEX') AS tickers,
      (SELECT COUNT(*)::bigint FROM candles WHERE timeframe = ${TIMEFRAME}) AS candles,
      (SELECT COUNT(*)::bigint FROM features) AS features,
      (SELECT COUNT(*)::bigint FROM detected_patterns) AS detected_patterns,
      (SELECT COUNT(*)::bigint FROM feature_combinations WHERE is_active = true AND name LIKE 'auto-engine:%') AS combinations_checked,
      (SELECT COUNT(*)::bigint FROM feature_combinations WHERE is_active = true AND statistical_significance = true) AS combinations_significant,
      (SELECT COUNT(*)::bigint FROM market_levels WHERE timeframe = ${TIMEFRAME}) AS levels,
      (SELECT COUNT(*)::bigint FROM asset_correlations WHERE timeframe = ${TIMEFRAME}) AS correlations,
      (SELECT COUNT(*)::bigint FROM pattern_statistics WHERE is_significant = true) AS patterns_confirmed
  `);
  return result.rows[0] as Record<string, number | string | null>;
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
    "/refresh — полностью обновить данные и исследование",
    "/help — справка",
    "",
    "Данные: исторические свечи MOEX и рассчитанные признаки.",
    `Для полного обновления нажмите «${REFRESH_BUTTON}».`,
  ].join("\n");
}

function isRefreshRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === REFRESH_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "/refresh" ||
    normalizedText === "обновить исследование"
  );
}

function isSignalPickerRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === SIGNAL_PICKER_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "сигнал по тикеру" ||
    normalizedText === "/signal"
  );
}

async function signalPicker() {
  const rows = await db
    .select({
      ticker: moexTickers.secid,
      shortName: moexTickers.shortName,
    })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(asc(moexTickers.rank));

  const buttons = rows.map((row) => ({
    text: row.shortName
      ? `${row.ticker} — ${row.shortName.slice(0, 18)}`
      : row.ticker,
    callback_data: `signal:${row.ticker}`,
  }));

  return {
    text: "🎯 Выберите акцию IMOEX для анализа:",
    replyMarkup: {
      inline_keyboard: Array.from(
        { length: Math.ceil(buttons.length / 2) },
        (_, index) => buttons.slice(index * 2, index * 2 + 2),
      ),
    },
  };
}

async function researchResultsText() {
  const rows = await db
    .select({
      name: featureCombinations.name,
      conditions: featureCombinations.conditions,
      direction: featureCombinations.direction,
      occurrences: featureCombinations.occurrences,
      successRate: featureCombinations.successRate,
      profitFactor: featureCombinations.profitFactor,
      expectedValue: featureCombinations.expectedValue,
      averageProfit: featureCombinations.averageProfit,
      maxDrawdown: featureCombinations.maxDrawdown,
      bestTakeProfit: featureCombinations.bestTakeProfit,
      bestStopLoss: featureCombinations.bestStopLoss,
      bestHoldingMinutes: featureCombinations.bestHoldingMinutes,
      testWinRate: featureCombinations.testWinRate,
      testExpectedValue: featureCombinations.testExpectedValue,
      testProfitFactor: featureCombinations.testProfitFactor,
      pValue: featureCombinations.pValue,
    })
    .from(featureCombinations)
    .where(
      and(
        eq(featureCombinations.isActive, true),
        eq(featureCombinations.statisticalSignificance, true),
        sql`${featureCombinations.name} LIKE 'auto-engine:%'`,
      ),
    )
    .orderBy(
      desc(featureCombinations.testExpectedValue),
      desc(featureCombinations.expectedValue),
    )
    .limit(5);

  if (!rows.length) {
    return "Новых статистически значимых закономерностей пока не найдено.";
  }

  const blocks = rows.map((row, index) => {
    const conditions = row.conditions
      .map((condition) => String(condition.label ?? condition.key ?? "фактор"))
      .join(" + ");
    const title =
      conditions ||
      row.name.replace(/^auto-engine:/, "").replace(/:SELL:|:BUY:/, " ");
    return [
      `${index + 1}. ${title}`,
      `Направление: ${row.direction ?? "—"}`,
      `Появлений: ${row.occurrences}`,
      `Win rate: ${formatNumber((row.successRate ?? 0) * 100, 2)}%`,
      `Profit factor: ${formatNumber(row.profitFactor)}`,
      `Expectancy: ${formatNumber(row.expectedValue, 4)}%`,
      `Средняя прибыль: ${formatNumber(row.averageProfit, 4)}%`,
      `Максимальная просадка: ${formatNumber(row.maxDrawdown, 4)}%`,
      `Лучший TP: ${formatNumber(row.bestTakeProfit)}%`,
      `Лучший SL: ${formatNumber(row.bestStopLoss)}%`,
      `Срок удержания: ${row.bestHoldingMinutes ?? "—"} минут`,
      `Test win rate: ${formatNumber((row.testWinRate ?? 0) * 100, 2)}%`,
      `Test expectancy: ${formatNumber(row.testExpectedValue, 4)}%`,
      `Test profit factor: ${formatNumber(row.testProfitFactor)}`,
      `p-value: ${formatNumber(row.pValue, 6)}`,
    ].join("\n");
  });

  return [
    "📊 Лучшие найденные закономерности",
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "Это статистические результаты исследования, а не финансовая рекомендация.",
  ].join("\n");
}

function startResearchRefresh(notify: (text: string) => Promise<unknown>) {
  if (researchRefreshRunning) {
    return {
      started: false,
      completion: Promise.resolve(
        "⏳ Полное обновление уже выполняется. Дождитесь сообщения о завершении.",
      ),
    };
  }

  researchRefreshRunning = true;
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@workspace/scripts",
      "run",
      "research-refresh",
      "--",
      "--skip-import",
      "--skip-context",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const progressSent = new Set<string>();
  const heartbeat = setInterval(() => {
    void notify(
      "⏳ Обновление ещё выполняется. Данные пересчитываются, процесс не завис.",
    ).catch((error) => {
      logger.warn({ err: error }, "Research refresh heartbeat notification failed");
    });
  }, 60_000);
  const notifyOnce = (key: string, text: string) => {
    if (progressSent.has(key)) return;
    progressSent.add(key);
    void notify(text).catch((error) => {
      logger.warn({ err: error, key }, "Research refresh progress notification failed");
    });
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const output = chunk.toString().trim();
    logger.info({ output }, "Research refresh output");
    if (output.includes("=== Исследовательское ядро комбинаций факторов")) {
      notifyOnce(
        "engine-start",
        "🧠 Исследовательское ядро запущено: перебираю факторы и проверяю статистическую устойчивость.",
      );
    }
    if (output.includes("Готово. Событий:")) {
      notifyOnce(
        "engine-done",
        "✅ Исследовательское ядро завершило перебор комбинаций.",
      );
      void researchResultsText()
        .then((results) =>
          notify(
            `📊 Предварительный отчёт по исследовательскому ядру:\n\n${results}`,
          ),
        )
        .catch((error) => {
          logger.warn({ err: error }, "Research refresh early report failed");
        });
    }
    if (output.includes("=== Обновление свечных паттернов")) {
      notifyOnce("patterns-start", "🕯 Обновляю свечные модели.");
    }
    if (output.includes("Свечные паттерны:")) {
      notifyOnce("patterns-done", "✅ Свечные модели обновлены.");
    }
    if (output.includes("=== Обновление уровней и корреляций")) {
      notifyOnce("levels-start", "📐 Обновляю уровни и корреляции.");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logger.warn({ output: chunk.toString().trim() }, "Research refresh error output");
  });

  const completion = once(child, "exit").then(([code, signal]) => {
    clearInterval(heartbeat);
    researchRefreshRunning = false;
    if (code === 0) {
      return researchResultsText().then((results) =>
        [
        "✅ Исследование обновлено.",
        "",
        "Пересчитаны исследовательское ядро, свечные модели, уровни и корреляции на уже сохранённых свечах MOEX.",
        "Новые результаты уже используются командами /signal и /top.",
        "",
        results,
      ].join("\n"),
      );
    }
    return [
      "❌ Полное обновление завершилось с ошибкой.",
      `Код: ${code ?? "нет"}${signal ? `, сигнал: ${signal}` : ""}`,
      "Подробности сохранены в журнале сервера.",
    ].join("\n");
  });

  child.once("error", (error) => {
    logger.error({ err: error }, "Research refresh process failed to start");
  });

  return { started: true, completion };
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
  const bestCombination =
    analysis.matched
      .filter((combination) => combination.direction === analysis.direction)
      .sort((left, right) => (right.expectedValue ?? -Infinity) - (left.expectedValue ?? -Infinity))[0] ??
    analysis.matched[0];
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
    `Прогноз/уверенность: ${analysis.confidence}%`,
    `Win rate закономерности: ${bestCombination ? formatNumber((bestCombination.successRate ?? 0) * 100, 2) : "—"}%`,
    `Profit factor: ${bestCombination ? formatNumber(bestCombination.profitFactor) : "—"}`,
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
  const startedAt = Date.now();
  cachedSignalContext = null;
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
  const candidates: TopCandidate[] = [];
  let matchedLaws = 0;
  for (const item of analyses) {
    const evidence = topEvidence(item.analysis);
    const confirmations = topConfirmations(item.row, item.analysis);
    const backtest = getBacktestEvidence(item.analysis);
    const blocks = scoreBlocks(
      item.row,
      item.analysis,
      context,
      evidence,
      backtest,
    );
    const rating = weightedScore(blocks);
    const matchedPatterns = item.analysis.matchedPatterns
      .map(
        (pattern) =>
          `${pattern.patternType} (${formatNumber((pattern.successRate ?? 0) * 100, 1)}% WR)`,
      );
    const matchedFactors = item.analysis.matched
      .flatMap((combination) =>
        combination.conditions.map((condition) =>
          String(condition.label ?? condition.key ?? "фактор"),
        ),
      )
      .filter((factor, index, factors) => factors.indexOf(factor) === index);
    matchedLaws +=
      item.analysis.matched.length + item.analysis.matchedPatterns.length;
    candidates.push({
      ...item,
      evidence,
      confirmations,
      matchedFactorCount:
        item.analysis.matched.length + item.analysis.matchedPatterns.length,
      rating,
      scoreBlocks: blocks,
      matchedPatterns,
      matchedFactors,
      backtest,
    });
  }
  const ranked = candidates
    .sort(
      (left, right) =>
        right.rating - left.rating ||
        (right.evidence ? evidenceScore(right.evidence) : 0) -
          (left.evidence ? evidenceScore(left.evidence) : 0),
    )
    .slice(0, 5);

  const stats = await getTopAnalysisStats();
  const formatCount = (value: number | string | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : Number(value).toLocaleString("ru-RU");
  const macroSummary = context.macro.length
    ? context.macro
        .map(
          (item) =>
            `${item.code} ${item.changePercent === null ? "—" : `${item.changePercent > 0 ? "+" : ""}${formatNumber(item.changePercent, 2)}%`}`,
        )
        .join(" · ")
    : "нет данных";
  const blocks = ranked.map((candidate, index) => {
    const { row, analysis, evidence } = candidate;
    const entry = row.close;
    const risk = Math.abs(entry - analysis.stop);
    const reward = Math.abs(analysis.target - entry);
    const riskReward = risk > 0 ? reward / risk : null;
    const evidenceWinRate = evidence?.successRate ?? null;
    const evidenceExpectancy = evidence
      ? "expectancy" in evidence
        ? evidence.expectancy
        : evidence.expectedValue
      : null;
    const evidenceTestWinRate = evidence && "testWinRate" in evidence
      ? evidence.testWinRate
      : null;
    const evidencePValue = evidence && "pValue" in evidence ? evidence.pValue : null;
    const evidenceQValue = evidence && "qValue" in evidence ? evidence.qValue : null;
    const evidenceConfidenceHigh =
      evidence && "confidenceHigh" in evidence ? evidence.confidenceHigh : null;
    const evidenceSharpe =
      evidence && "sharpeRatio" in evidence
        ? evidence.sharpeRatio
        : candidate.backtest?.sharpeRatio ?? null;
    const scoreLines = [
      { name: "Trend", value: candidate.scoreBlocks.trend },
      { name: "Momentum", value: candidate.scoreBlocks.momentum },
      { name: "Volume", value: candidate.scoreBlocks.volume },
      { name: "Pattern", value: candidate.scoreBlocks.pattern },
      { name: "Breakout", value: candidate.scoreBlocks.breakout },
      { name: "SMC", value: candidate.scoreBlocks.smc },
      { name: "Support/Resistance", value: candidate.scoreBlocks.structure },
      { name: "Correlation", value: candidate.scoreBlocks.correlation },
      { name: "Research", value: candidate.scoreBlocks.research },
      { name: "Backtest", value: candidate.scoreBlocks.backtest },
      { name: "Risk", value: candidate.scoreBlocks.risk },
      { name: "Market Context", value: candidate.scoreBlocks.marketContext },
    ]
      .map(({ name, value }) => `• ${name}: ${formatNumber(value, 1)}/100`)
      .join("\n");
    const source = evidence
      ? "patternType" in evidence
        ? `Паттерн: ${evidence.patternType}`
        : `Комбинация: ${evidence.conditions
            .map((condition) => String(condition.label ?? condition.key ?? "фактор"))
            .join(" + ")}`
      : "Подтверждённая историческая закономерность не найдена";
    return [
      `${index + 1}. 📈 ${row.ticker} — ${directionLabel(analysis.direction)}`,
      `AI Score: ${candidate.rating}/100`,
      `Уверенность: ${analysis.confidence}%`,
      `Вход: ${formatNumber(entry)}`,
      `Стоп: ${formatNumber(analysis.stop)} · Тейк: ${formatNumber(analysis.target)}`,
      `Risk/Reward: 1 : ${formatNumber(riskReward, 2)}`,
      `Горизонт: ${analysis.horizonMinutes} минут`,
      "",
      "Блоки AI Score:",
      scoreLines,
      "",
      "Историческая статистика:",
      `• ${source}`,
      `• Появлений: ${formatCount(evidence?.occurrences)}`,
      `• Win Rate: ${formatNumber(
        evidenceWinRate !== null ? evidenceWinRate * 100 : null,
        2,
      )}%`,
      `• Test Win Rate: ${formatNumber(
        evidenceTestWinRate !== null ? evidenceTestWinRate * 100 : null,
        2,
      )}%`,
      `• Profit Factor: ${formatNumber(evidence?.profitFactor)}`,
      `• Expectancy: ${formatNumber(evidenceExpectancy, 4)}%`,
      `• Train: ${formatNumber(
        evidence &&
        "trainWinRate" in evidence &&
        evidence.trainWinRate !== null
          ? evidence.trainWinRate * 100
          : null,
        2,
      )}% WR / ${formatNumber(
        evidence && "trainExpectancy" in evidence
          ? evidence.trainExpectancy
          : evidence && "trainExpectedValue" in evidence
            ? evidence.trainExpectedValue
            : null,
        4,
      )}%`,
      `• Средняя прибыль/убыток: ${formatNumber(evidence?.averageProfit, 4)}% / ${formatNumber(evidence?.averageLoss, 4)}%`,
      `• Просадка: ${formatNumber(evidence?.maxDrawdown, 4)}%`,
      `• Sharpe: ${formatNumber(evidenceSharpe, 3)}`,
      `• Лучший TP/SL: ${formatNumber(evidence?.bestTakeProfit)}% / ${formatNumber(evidence?.bestStopLoss)}%`,
      `• p-value/q-value: ${formatNumber(evidencePValue, 6)} / ${formatNumber(evidenceQValue, 6)}`,
      `• Доверительный интервал: ${formatNumber(
        evidence &&
        evidence.confidenceLow !== null &&
        evidence.confidenceLow !== undefined
          ? evidence.confidenceLow * 100
          : null,
        2,
      )}%–${formatNumber(
        evidenceConfidenceHigh !== null && evidenceConfidenceHigh !== undefined
          ? evidenceConfidenceHigh * 100
          : null,
        2,
      )}%`,
      "",
      `Подтверждений: ${candidate.confirmations.filter(
        (reason) =>
          !reason.includes("исторических комбинаций") &&
          !reason.includes("подтверждённых паттернов"),
      ).length}`,
      `Совпавших паттернов: ${candidate.matchedPatterns.length}`,
      candidate.matchedPatterns.length
        ? `Паттерны: ${candidate.matchedPatterns.join(", ")}`
        : null,
      `Совпавших факторов: ${candidate.matchedFactors.length}`,
      candidate.matchedFactors.length
        ? `Факторы: ${candidate.matchedFactors.join(", ")}`
        : null,
      "Подтверждения индикаторов:",
      ...candidate.confirmations.slice(0, 10).map((reason) => `• ${reason}`),
      `Почему AI выбрал: ${candidate.confirmations
        .filter(
          (reason) =>
            !reason.includes("исторических комбинаций") &&
            !reason.includes("подтверждённых паттернов"),
        )
        .slice(0, 3)
        .join("; ") || "есть подтверждённая историческая закономерность и положительный тест"}`,
      analysis.marketStructure.support !== null
        ? `• Поддержка: ${formatNumber(analysis.marketStructure.support)} (сила ${formatNumber(analysis.marketStructure.supportStrength)})`
        : null,
      analysis.marketStructure.resistance !== null
        ? `• Сопротивление: ${formatNumber(analysis.marketStructure.resistance)} (сила ${formatNumber(analysis.marketStructure.resistanceStrength)})`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  });

  return [
    "🔥 Лучшие сигналы — realtime-анализ IMOEX",
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "📊 Статистика работы AI:",
    `• Акций проанализировано: ${formatCount(stats.tickers)}`,
    `• Свечей: ${formatCount(stats.candles)}`,
    `• Признаков просмотрено: ${formatCount(stats.features)}`,
    `• Паттернов найдено: ${formatCount(stats.detected_patterns)}`,
    `• Паттернов подтверждено: ${formatCount(stats.patterns_confirmed)}`,
    `• Комбинаций факторов проверено: ${formatCount(stats.combinations_checked)}`,
    `• Статистически значимых комбинаций: ${formatCount(stats.combinations_significant)}`,
    `• Закономерностей совпало: ${formatCount(matchedLaws)}`,
    `• Уровней: ${formatCount(stats.levels)}`,
    `• Корреляций: ${formatCount(stats.correlations)}`,
    `• Рыночный контекст: ${macroSummary}`,
    `• Версия ядра: ${RESEARCH_ENGINE_VERSION}`,
    `• Веса Score: Trend ${AI_SCORE_WEIGHTS.trend * 100}% · Momentum ${AI_SCORE_WEIGHTS.momentum * 100}% · Pattern ${AI_SCORE_WEIGHTS.pattern * 100}% · Research ${AI_SCORE_WEIGHTS.research * 100}% · Backtest ${AI_SCORE_WEIGHTS.backtest * 100}%`,
    `• Время анализа: ${formatNumber((Date.now() - startedAt) / 1000, 1)} сек.`,
    "",
    "Для детального сигнала: /signal ТИКЕР",
    "Это статистический исследовательский сигнал, не финансовая рекомендация.",
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
  if (isSignalPickerRequest(text)) {
    return "Нажмите кнопку «🎯 Сигнал по тикеру», чтобы выбрать акцию.";
  }
  if (isRefreshRequest(text)) {
    return "Запуск обновления...";
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

function splitTelegramText(text: string, maxLength = 3900) {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const boundary = rest.lastIndexOf("\n", maxLength);
    const cutAt = boundary > 500 ? boundary : maxLength;
    chunks.push(rest.slice(0, cutAt));
    rest = rest.slice(cutAt).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
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
    answerCallbackQuery: (callbackQueryId: string, text?: string) =>
      call<boolean>("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
      }),
    getUpdates: (offset: number, signal: AbortSignal) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: JSON.stringify(["message", "callback_query"]),
        },
        signal,
      ),
    sendMessage: async (
      chatId: number,
      text: string,
      replyMarkup: Record<string, unknown> = TELEGRAM_MENU,
    ) => {
      let result: unknown;
      for (const chunk of splitTelegramText(text)) {
        result = await call("sendMessage", {
          chat_id: chatId,
          text: chunk,
          reply_markup: JSON.stringify(replyMarkup),
        });
      }
      return result;
    },
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
          { command: "refresh", description: "Обновить данные и исследование" },
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
            const callback = update.callback_query;
            if (callback) {
              const callbackData = callback.data ?? "";
              const callbackChatId = callback.message?.chat.id;
              try {
                await client.answerCallbackQuery(
                  callback.id,
                  callbackData.startsWith("signal:")
                    ? "Анализирую акцию..."
                    : undefined,
                );
                if (callbackChatId && callbackData.startsWith("signal:")) {
                  const ticker = callbackData
                    .slice("signal:".length)
                    .toUpperCase()
                    .replace(/[^A-Z0-9_]/g, "");
                  const response = await signalText(ticker);
                  await client.sendMessage(callbackChatId, response);
                  logger.info({ ticker }, "Telegram ticker signal sent");
                }
              } catch (error) {
                logger.error({ err: error, callbackData }, "Telegram callback failed");
                if (callbackChatId) {
                  await client.sendMessage(
                    callbackChatId,
                    "Не удалось получить сигнал. Попробуйте выбрать тикер ещё раз.",
                  );
                }
              }
              continue;
            }
            const message = update.message;
            if (!message?.text) continue;
            const command = message.text.trim().split(/\s+/, 1)[0];
            logger.info({ command }, "Telegram command received");
            try {
              if (isSignalPickerRequest(message.text)) {
                const picker = await signalPicker();
                await client.sendMessage(
                  message.chat.id,
                  picker.text,
                  picker.replyMarkup,
                );
                logger.info({ command }, "Telegram ticker picker sent");
                continue;
              }
              if (isRefreshRequest(message.text)) {
                const refresh = startResearchRefresh((progress) =>
                  client.sendMessage(message.chat.id, progress),
                );
                await client.sendMessage(
                  message.chat.id,
                  refresh.started
                    ? "🔄 Запустил полное обновление.\n\nЭто может занять длительное время. Я сообщу, когда всё завершится."
                    : "⏳ Полное обновление уже выполняется. Второй запуск не требуется.",
                );
                if (refresh.started) {
                  void refresh.completion
                    .then((result) => client.sendMessage(message.chat.id, result))
                    .catch(async (error) => {
                      logger.error({ err: error }, "Research refresh completion notification failed");
                      await client.sendMessage(
                        message.chat.id,
                        "❌ Не удалось отправить итог обновления. Проверьте журнал сервера.",
                      );
                    });
                }
                logger.info({ command }, "Telegram research refresh handled");
                continue;
              }
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