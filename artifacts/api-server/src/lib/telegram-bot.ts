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
  bestTakeProfit: number | null;
  bestStopLoss: number | null;
  bestHoldingMinutes: number | null;
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
type MarketStructure = {
  support: number | null;
  resistance: number | null;
  correlation: number | null;
  correlationSamples: number | null;
};
type SignalContext = {
  combinations: Combination[];
  volatilityMedian: number | null;
  thresholdsByTicker: Map<string, FactorThresholds>;
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
      bestTakeProfit: featureCombinations.bestTakeProfit,
      bestStopLoss: featureCombinations.bestStopLoss,
      bestHoldingMinutes: featureCombinations.bestHoldingMinutes,
    })
    .from(featureCombinations)
    .where(
      and(
        eq(featureCombinations.isActive, true),
        sql`${featureCombinations.name} LIKE 'auto-engine:%'`,
      ),
    )
    .orderBy(desc(featureCombinations.expectedValue));
  return result as Combination[];
}

function matchesCombination(
  feature: LatestFeature,
  combination: Combination,
  thresholds: FactorThresholds | undefined,
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
        return false;
    }
  });
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
  const [combinations, patternRows, levelRows, correlationRows, thresholdsByTicker] =
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
      getFactorThresholds(),
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
    thresholdsByTicker,
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
  const thresholds = context.thresholdsByTicker.get(ticker);
  const marketStructure = marketStructureFromContext(
    ticker,
    feature.close,
    context,
  );
  const matched = combinations.filter((combination) =>
    matchesCombination(feature, combination, thresholds),
  );
  const matchedPatterns: CandlePattern[] = [];
  if (!matched.length) {
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
  const best = relevant[0] ?? matched[0] ?? null;
  const confidence = Math.round(
    Math.max(
      50,
      Math.min(
        95,
        ((best?.successRate ?? 0.5) * 100 +
          (best?.confidenceHigh ?? 0.5) * 100) /
          2,
      ),
    ),
  );
  const horizonMinutes = best?.holdingMinutes ?? 60;
  const bestTakeProfit = best?.bestTakeProfit;
  const bestStopLoss = best?.bestStopLoss;
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