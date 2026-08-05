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
  telegramCommoditySubscriptions,
  telegramMoneyTestSubscriptions,
} from "@workspace/db";
import { logger } from "./logger";
import { scanMarketAnalogues } from "./market-analog-scanner";
import { scanIntraday, type IntradayCandidate } from "./intraday-scanner";
import {
  scanElliottWaveStrategies,
  type ElliottCandidate,
  type ElliottScanResult,
} from "./elliott-wave-scanner";
import {
  scanSmartMoney,
  type SmartMoneyCandidate,
} from "./smart-money-scanner";
import {
  scanMoneyTest,
  type MoneyTestScan,
} from "./money-test-scanner";

const TELEGRAM_API = "https://api.telegram.org";
const TIMEFRAME = "10m";
const MIN_TRADE_PERCENT = 0.3;
const POLL_TIMEOUT_SECONDS = 25;
const REFRESH_BUTTON = "🔄 Обновить исследование";
const SIGNAL_PICKER_BUTTON = "🎯 Сигнал по тикеру";
const ANALOG_BUTTON = "📊 Аналогичные рыночные ситуации";
const ACCURACY_BUTTON = "📊 Точность сигналов";
const INTRADAY_BUTTON = "⚡ Внутри дня";
const WAVES_BUTTON = "🌊 Волновой анализ";
const WAVE_STATS_BUTTON = "📒 Статистика волн";
const SMART_MONEY_BUTTON = "💰 Smart Money";
const COMMODITIES_BUTTON = "🪙 Сырьё и металлы";
const MONEY_TEST_BUTTON = "💵 Деньги тест";
const COMPANY_ANALYSIS_BUTTON = "🔎 Аналитика компании";
const SIGNAL_MAX_AGE_MINUTES = 30;
const PAPER_HORIZON_MINUTES = 360;
const INTRADAY_HORIZON_MINUTES = 60;
const PAPER_EVALUATION_INTERVAL_MS = 10 * 60 * 1000;
const INTRADAY_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const COMMODITY_SCAN_INTERVAL_MS = 3 * 60 * 1000;
const MONEY_TEST_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const WAVE_SCAN_INTERVAL_MS = 30 * 60 * 1000;
const PAPER_COMMISSION_ONE_WAY_PERCENT = 0.05;
const PAPER_SLIPPAGE_ONE_WAY_PERCENT = 0.05;
const PAPER_TRANSACTION_COST_PERCENT =
  (PAPER_COMMISSION_ONE_WAY_PERCENT + PAPER_SLIPPAGE_ONE_WAY_PERCENT) * 2;
const PAPER_MAX_ACTIVE_SIGNALS = 5;
const PAPER_MAX_DAILY_LOSS_PERCENT = 2;
const SMART_MONEY_1M_MAX_AGE_MS = 15 * 60 * 1000;
const SMART_MONEY_1H_MAX_AGE_MS = 90 * 60 * 1000;
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
    [SMART_MONEY_BUTTON],
    [COMMODITIES_BUTTON],
    [MONEY_TEST_BUTTON],
    [COMPANY_ANALYSIS_BUTTON],
    ["❓ Помощь"],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
let researchRefreshRunning = false;
let latestMarketRefresh: Promise<void> | null = null;
let latestIntradayRefresh: Promise<void> | null = null;
let latestWaveRefresh: Promise<void> | null = null;
let latestSmartMoneyHigherRefresh: Promise<void> | null = null;
const companyAnalysisRefreshes = new Map<string, Promise<void>>();
let paperEvaluationRunning = false;
let intradayScanRunning = false;
let waveScanRunning = false;
let smartMoneyScanRunning = false;
let commodityScanRunning = false;
let latestCommodityRefresh: Promise<void> | null = null;
let commodityNotifier: ((chatId: number, text: string) => Promise<unknown>) | null = null;
const commodityChatIds = new Set<number>();
let moneyTestScanRunning = false;
let moneyTestNotifier: ((chatId: number, text: string) => Promise<unknown>) | null = null;
const moneyTestChatIds = new Set<number>();

async function loadCommoditySubscriptions() {
  const subscriptions = await db
    .select({ chatId: telegramCommoditySubscriptions.chatId })
    .from(telegramCommoditySubscriptions);
  for (const subscription of subscriptions) {
    if (Number.isSafeInteger(subscription.chatId)) {
      commodityChatIds.add(subscription.chatId);
    }
  }
  logger.info({ count: commodityChatIds.size }, "Commodity Telegram subscriptions loaded");
}

async function subscribeCommodityChat(chatId: number) {
  if (!Number.isSafeInteger(chatId)) return;
  commodityChatIds.add(chatId);
  await db
    .insert(telegramCommoditySubscriptions)
    .values({ chatId })
    .onConflictDoNothing();
}

async function loadMoneyTestSubscriptions() {
  const subscriptions = await db
    .select({ chatId: telegramMoneyTestSubscriptions.chatId })
    .from(telegramMoneyTestSubscriptions);
  for (const subscription of subscriptions) {
    if (Number.isSafeInteger(subscription.chatId)) {
      moneyTestChatIds.add(subscription.chatId);
    }
  }
  logger.info({ count: moneyTestChatIds.size }, "Money Test Telegram subscriptions loaded");
}

async function subscribeMoneyTestChat(chatId: number) {
  if (!Number.isSafeInteger(chatId)) return;
  moneyTestChatIds.add(chatId);
  await db
    .insert(telegramMoneyTestSubscriptions)
    .values({ chatId })
    .onConflictDoNothing();
}

type PaperRecordResult = "recorded" | "duplicate" | "risk_limit";
type TelegramMessage = {
  text: string;
  replyMarkup?: Record<string, unknown>;
};

type TelegramReply = string | TelegramMessage;

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
type SignalAnalysis = {
  direction: SignalDirection;
  confidence: number;
  reasons: string[];
  stop: number;
  target: number;
  horizonMinutes: number;
  matched: Combination[];
  matchedPatterns: ProfessionalPattern[];
  historicalEvidence: Combination | ProfessionalPattern | null;
  marketStructure: MarketStructure;
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
  if (direction === "BUY") return "ЛОНГ";
  if (direction === "SELL") return "ШОРТ";
  return "НЕЙТРАЛЬНО";
}

function dataAgeMinutes(timestamp: Date) {
  return Math.max(0, (Date.now() - timestamp.getTime()) / 60_000);
}

function dataFreshnessText(timestamp: Date) {
  return `Свеча: ${formatDate(timestamp)} · возраст данных: ${formatNumber(dataAgeMinutes(timestamp), 0)} мин`;
}

function marketRegime(change: number | null | undefined) {
  if (change !== null && change !== undefined && change > 0.15) return "восходящий";
  if (change !== null && change !== undefined && change < -0.15) return "нисходящий";
  return "боковой";
}

function paperRecordText(result: PaperRecordResult) {
  if (result === "recorded") return "Сигнал сохранён для проверки результата.";
  if (result === "duplicate") return "Эта свеча уже была сохранена ранее.";
  return "Paper-сигнал не сохранён: достигнут лимит риска или активных сигналов.";
}

async function recordPaperSignal(input: {
  ticker: string;
  featureTimestamp: Date;
  direction: SignalDirection;
  confidence: number;
  entryPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  horizonMinutes: number;
  reasons: string[];
  patternIds: number[];
  combinationIds: number[];
  source:
    | "telegram"
    | "top"
    | "intraday"
    | "wave"
    | "smartmoney"
    | "commodity-smartmoney"
    | "money-test";
  timeframe?: string;
  metadata?: Record<string, unknown>;
  bypassRiskLimits?: boolean;
}): Promise<PaperRecordResult> {
  if (input.direction === "HOLD") return "risk_limit";
  const timeframe = input.timeframe ?? TIMEFRAME;
  const existing = await db
    .select({ id: signalsHistory.id })
    .from(signalsHistory)
    .where(
      and(
        eq(signalsHistory.ticker, input.ticker),
        eq(signalsHistory.timeframe, timeframe),
        eq(signalsHistory.candleTimestamp, input.featureTimestamp),
        eq(signalsHistory.direction, input.direction),
        sql`COALESCE(${signalsHistory.metadata}->>'source', '') = ${input.source}`,
      ),
    )
    .limit(1);
  if (existing.length) return "duplicate";

  const riskScope =
    input.source === "smartmoney" ||
    input.source === "commodity-smartmoney" ||
    input.source === "money-test"
      ? sql`AND metadata ->> 'source' = ${input.source}`
    : sql``;
  const limits = input.bypassRiskLimits
    ? null
    : await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE outcome IS NULL)::int AS active_count,
      COALESCE(SUM(outcome_percent) FILTER (
        WHERE outcome IS NOT NULL
          AND generated_at >= CURRENT_DATE
      ), 0)::double precision AS daily_result
    FROM signals_history
    WHERE metadata ->> 'paperTrading' = 'true'
      ${riskScope}
  `);
  if (limits) {
    const limitRow = (limits.rows[0] ?? {}) as Record<string, unknown>;
    const activeCount = Number(limitRow.active_count) || 0;
    const dailyResult = Number(limitRow.daily_result) || 0;
    if (
      activeCount >= PAPER_MAX_ACTIVE_SIGNALS ||
      dailyResult <= -PAPER_MAX_DAILY_LOSS_PERCENT
    ) {
      return "risk_limit";
    }
  }

  await db.insert(signalsHistory).values({
    ticker: input.ticker,
    timeframe,
    candleTimestamp: input.featureTimestamp,
    direction: input.direction,
    confidence: input.confidence,
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    targetPrice: input.targetPrice,
    horizonMinutes: input.horizonMinutes,
    reasons: input.reasons,
    patternIds: input.patternIds,
    combinationIds: input.combinationIds,
    metadata: {
      source: input.source,
      paperTrading: true,
      ...input.metadata,
    },
  });
  return "recorded";
}

async function evaluatePaperSignals() {
  const pending = await db.execute(sql`
    SELECT
      id,
      ticker,
      direction,
      entry_price AS "entryPrice",
      stop_price AS "stopPrice",
      target_price AS "targetPrice",
      horizon_minutes AS "horizonMinutes",
      timestamp AS "candleTimestamp",
      metadata
    FROM signals_history
    WHERE outcome IS NULL
      AND metadata ->> 'paperTrading' = 'true'
      AND COALESCE(metadata ->> 'source', '') NOT IN (
        'wave',
        'commodity-smartmoney',
        'money-test'
      )
    ORDER BY id
    LIMIT 500
  `);

  for (const rawRow of pending.rows) {
    const row = rawRow as Record<string, unknown>;
    const id = Number(row.id);
    const ticker = String(row.ticker);
    const direction = String(row.direction);
    const entryPrice = Number(row.entryPrice);
    const stopPrice =
      row.stopPrice === null || row.stopPrice === undefined
        ? null
        : Number(row.stopPrice);
    const targetPrice =
      row.targetPrice === null || row.targetPrice === undefined
        ? null
        : Number(row.targetPrice);
    const horizonMinutes = Number(row.horizonMinutes) || PAPER_HORIZON_MINUTES;
    const candleTimestamp =
      row.candleTimestamp instanceof Date
        ? row.candleTimestamp
        : new Date(String(row.candleTimestamp));
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const candleTimeframe =
      metadata.intraday === true
        ? "1m"
        : typeof metadata.executionTimeframe === "string"
          ? metadata.executionTimeframe
          : typeof metadata.timeframe === "string"
            ? metadata.timeframe
          : TIMEFRAME;
    if (
      !Number.isFinite(id) ||
      !Number.isFinite(entryPrice) ||
      !Number.isFinite(candleTimestamp.getTime()) ||
      (direction !== "BUY" && direction !== "SELL")
    ) {
      continue;
    }

    const deadline = new Date(candleTimestamp.getTime() + horizonMinutes * 60_000);
    const candlesResult = await db.execute(sql`
      SELECT timestamp, high, low, close
      FROM candles
      WHERE ticker = ${ticker}
        AND timeframe = ${candleTimeframe}
        AND timestamp > ${candleTimestamp}
        AND timestamp <= ${deadline}
      ORDER BY timestamp
    `);
    if (!candlesResult.rows.length) continue;

    let outcome: string | null = null;
    let outcomePercent: number | null = null;
    let grossOutcomePercent: number | null = null;
    let outcomeAt: Date | null = null;
    let lastClose: number | null = null;
    let lastTimestamp: Date | null = null;

    for (const rawCandle of candlesResult.rows) {
      const candle = rawCandle as Record<string, unknown>;
      const timestamp =
        candle.timestamp instanceof Date
          ? candle.timestamp
          : new Date(String(candle.timestamp));
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);
      if (
        !Number.isFinite(timestamp.getTime()) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
      ) {
        continue;
      }
      lastClose = close;
      lastTimestamp = timestamp;
      const hitTarget =
        targetPrice !== null &&
        Number.isFinite(targetPrice) &&
        (direction === "BUY" ? high >= targetPrice : low <= targetPrice);
      const hitStop =
        stopPrice !== null &&
        Number.isFinite(stopPrice) &&
        (direction === "BUY" ? low <= stopPrice : high >= stopPrice);

      if (hitTarget || hitStop) {
        // If both levels are inside one candle, use SL conservatively.
        const isWin = hitTarget && !hitStop;
        const exitPrice = isWin ? targetPrice : stopPrice;
        if (exitPrice === null || !Number.isFinite(exitPrice)) continue;
        outcome = isWin ? "TP" : "SL";
        grossOutcomePercent =
          direction === "BUY"
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - exitPrice) / entryPrice) * 100;
        outcomePercent = grossOutcomePercent - PAPER_TRANSACTION_COST_PERCENT;
        outcomeAt = timestamp;
        break;
      }
    }

    if (
      outcome === null &&
      lastClose !== null &&
      lastTimestamp !== null &&
      lastTimestamp.getTime() >= deadline.getTime()
    ) {
      grossOutcomePercent =
        direction === "BUY"
          ? ((lastClose - entryPrice) / entryPrice) * 100
          : ((entryPrice - lastClose) / entryPrice) * 100;
      outcomePercent = grossOutcomePercent - PAPER_TRANSACTION_COST_PERCENT;
      outcome = outcomePercent >= 0 ? "TIMEOUT_WIN" : "TIMEOUT_LOSS";
      outcomeAt = lastTimestamp;
    }

    if (outcome && outcomeAt && outcomePercent !== null) {
      await db.execute(sql`
        UPDATE signals_history
        SET outcome = ${outcome},
            outcome_percent = ${outcomePercent},
            outcome_at = ${outcomeAt},
            metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
              paperCostPercent: PAPER_TRANSACTION_COST_PERCENT,
              commissionOneWayPercent: PAPER_COMMISSION_ONE_WAY_PERCENT,
              slippageOneWayPercent: PAPER_SLIPPAGE_ONE_WAY_PERCENT,
              grossOutcomePercent,
            })}::jsonb
        WHERE id = ${id}
          AND outcome IS NULL
      `);
    }
  }
}

async function manualWaveOutcome(
  signalId: number,
  outcomePercent: number,
  label: "win" | "loss" | "custom",
) {
  if (!Number.isInteger(signalId) || !Number.isFinite(outcomePercent)) {
    return "Укажите корректные данные: /wave_result ID процент";
  }
  const result = await db.execute(sql`
    UPDATE signals_history
    SET outcome = ${outcomePercent >= 0 ? "MANUAL_WIN" : "MANUAL_LOSS"},
        outcome_percent = ${outcomePercent},
        outcome_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          manualResult: true,
          manualResultLabel: label,
        })}::jsonb
    WHERE id = ${signalId}
      AND outcome IS NULL
      AND metadata ->> 'source' = 'wave'
    RETURNING ticker, timeframe, direction, outcome_percent AS "outcomePercent"
  `);
  const row = (result.rows[0] ?? null) as
    | { ticker?: string; timeframe?: string; direction?: string; outcomePercent?: number }
    | null;
  if (!row) {
    return `Волновой сигнал #${signalId} не найден или уже получил результат.`;
  }
  return [
    `✅ Результат волнового сигнала #${signalId} сохранён.`,
    `${row.ticker} · ${row.timeframe} · ${row.direction === "BUY" ? "LONG" : "SHORT"}`,
    `Фактический результат: ${outcomePercent >= 0 ? "+" : ""}${formatNumber(outcomePercent, 2)}%`,
    "Он учтён в статистике волнового анализа.",
  ].join("\n");
}

async function quickWaveOutcome(signalId: number, win: boolean) {
  const result = await db.execute(sql`
    SELECT entry_price AS "entryPrice",
           target_price AS "targetPrice",
           stop_price AS "stopPrice",
           direction,
           metadata
    FROM signals_history
    WHERE id = ${signalId}
      AND outcome IS NULL
      AND metadata ->> 'source' = 'wave'
    LIMIT 1
  `);
  const row = (result.rows[0] ?? null) as Record<string, unknown> | null;
  if (!row) return `Волновой сигнал #${signalId} не найден или уже получил результат.`;
  const entry = Number(row.entryPrice);
  const exit = Number(win ? row.targetPrice : row.stopPrice);
  const direction = String(row.direction);
  const gross =
    direction === "BUY"
      ? ((exit - entry) / entry) * 100
      : ((entry - exit) / entry) * 100;
  const net = gross - PAPER_TRANSACTION_COST_PERCENT;
  return manualWaveOutcome(signalId, net, win ? "win" : "loss");
}

async function waveStatsText() {
  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE outcome = 'MANUAL_WIN')::int AS wins,
      COUNT(*) FILTER (WHERE outcome = 'MANUAL_LOSS')::int AS losses,
      AVG(outcome_percent) FILTER (WHERE outcome IS NOT NULL) AS average_percent,
      COALESCE(SUM(outcome_percent) FILTER (WHERE outcome IS NOT NULL), 0) AS net_percent
    FROM signals_history
    WHERE metadata ->> 'source' = 'wave'
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const total = Number(row.total) || 0;
  const pending = Number(row.pending) || 0;
  const wins = Number(row.wins) || 0;
  const losses = Number(row.losses) || 0;
  const closed = wins + losses;
  const winRate = closed ? (wins / closed) * 100 : null;
  return [
    "📒 СТАТИСТИКА ВОЛНОВЫХ СИГНАЛОВ",
    "",
    `Всего записано: ${total}`,
    `Ожидают ручной оценки: ${pending}`,
    `Положительных: ${wins} · отрицательных: ${losses}`,
    `Win rate: ${formatNumber(winRate, 1)}%`,
    `Средний результат: ${formatNumber(Number(row.average_percent), 2)}%`,
    `Накопленный результат: ${formatNumber(Number(row.net_percent), 2)}%`,
    "",
    "Кнопки «сработал/не сработал» записывают paper-результат после издержек.",
    "Для точного результата: /wave_result ID процент, например /wave_result 123 1.25",
  ].join("\n");
}

async function accuracyText() {
  await evaluatePaperSignals();
  const summary = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE outcome IN ('TP', 'TIMEOUT_WIN'))::int AS wins,
      COUNT(*) FILTER (WHERE outcome IN ('SL', 'TIMEOUT_LOSS'))::int AS losses,
      AVG(outcome_percent) FILTER (WHERE outcome IS NOT NULL) AS "averagePercent",
      AVG((metadata->>'grossOutcomePercent')::double precision)
        FILTER (WHERE outcome IS NOT NULL) AS "grossAveragePercent",
      COALESCE(SUM(outcome_percent) FILTER (WHERE outcome IS NOT NULL), 0)
        AS "netTotalPercent",
      MIN(generated_at) AS first_signal,
      MAX(generated_at) AS last_signal
    FROM signals_history
    WHERE metadata ->> 'paperTrading' = 'true'
  `);
  const breakdown = await db.execute(sql`
    SELECT
      ticker,
      direction,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IN ('TP', 'TIMEOUT_WIN'))::int AS wins,
      COUNT(*) FILTER (WHERE outcome IN ('SL', 'TIMEOUT_LOSS'))::int AS losses,
      AVG(outcome_percent) FILTER (WHERE outcome IS NOT NULL) AS "averagePercent"
    FROM signals_history
    WHERE metadata ->> 'paperTrading' = 'true'
      AND outcome IS NOT NULL
    GROUP BY ticker, direction
    ORDER BY "averagePercent" DESC NULLS LAST, total DESC
    LIMIT 10
  `);
  const regimeBreakdown = await db.execute(sql`
    SELECT
      COALESCE(metadata->>'marketRegime', 'не указан') AS regime,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IN ('TP', 'TIMEOUT_WIN'))::int AS wins,
      AVG(outcome_percent) AS "averagePercent"
    FROM signals_history
    WHERE metadata ->> 'paperTrading' = 'true'
      AND outcome IS NOT NULL
    GROUP BY COALESCE(metadata->>'marketRegime', 'не указан')
    ORDER BY "averagePercent" DESC NULLS LAST
  `);
  const row = (summary.rows[0] ?? {}) as Record<string, unknown>;
  const total = Number(row.total) || 0;
  const pending = Number(row.pending) || 0;
  const wins = Number(row.wins) || 0;
  const losses = Number(row.losses) || 0;
  const closed = wins + losses;
  const winRate = closed ? (wins / closed) * 100 : null;
  const grossAverage = Number(row.grossAveragePercent);
  const netAverage = Number(row.averagePercent);
  const netTotal = Number(row.netTotalPercent) || 0;

  if (!total) {
    return [
      "📊 ТОЧНОСТЬ СИГНАЛОВ",
      "",
      "Paper trading пока не накопил завершённых сигналов.",
      "Нажимайте «🔥 Лучшие сигналы» или запрашивайте /signal ТИКЕР.",
      "Результат каждого сигнала будет проверен через 6 часов.",
    ].join("\n");
  }

  const latest = await db.execute(sql`
    SELECT ticker, direction, outcome, outcome_percent, generated_at
    FROM signals_history
    WHERE metadata ->> 'paperTrading' = 'true'
      AND outcome IS NOT NULL
    ORDER BY outcome_at DESC NULLS LAST, id DESC
    LIMIT 5
  `);
  const latestLines = latest.rows.map((raw) => {
    const item = raw as Record<string, unknown>;
    const percent = Number(item.outcome_percent);
    return `${item.ticker} ${directionLabel(String(item.direction) as SignalDirection)} · ${String(item.outcome)} · ${Number.isFinite(percent) ? `${percent >= 0 ? "+" : ""}${formatNumber(percent)}%` : "—"}`;
  });
  const breakdownLines = breakdown.rows.map((raw) => {
    const item = raw as Record<string, unknown>;
    const totalCases = Number(item.total) || 0;
    const winsByTicker = Number(item.wins) || 0;
    const rate = totalCases ? (winsByTicker / totalCases) * 100 : null;
    return `${item.ticker} ${directionLabel(String(item.direction) as SignalDirection)} · ${formatNumber(rate, 0)}% (${winsByTicker}/${totalCases}) · среднее ${formatNumber(Number(item.averagePercent))}%`;
  });
  const regimeLines = regimeBreakdown.rows.map((raw) => {
    const item = raw as Record<string, unknown>;
    const totalCases = Number(item.total) || 0;
    const winsByRegime = Number(item.wins) || 0;
    const rate = totalCases ? (winsByRegime / totalCases) * 100 : null;
    return `${String(item.regime)} · ${formatNumber(rate, 0)}% (${winsByRegime}/${totalCases}) · среднее ${formatNumber(Number(item.averagePercent))}%`;
  });

  return [
    "📊 ТОЧНОСТЬ СИГНАЛОВ",
    "",
    "Режим: PAPER TRADING — реальные сделки не совершаются",
    `Всего сигналов: ${total}`,
    `Завершено: ${closed}`,
    `Ожидают проверки: ${pending}`,
    `Прибыльных: ${wins}`,
    `Убыточных: ${losses}`,
    `Фактический win rate: ${formatNumber(winRate, 1)}%`,
    `Средний валовый результат: ${formatNumber(grossAverage, 2)}%`,
    `Средний чистый результат: ${formatNumber(netAverage, 2)}%`,
    `Накопленный чистый результат: ${netTotal >= 0 ? "+" : ""}${formatNumber(netTotal, 2)}%`,
    `Издержки в расчёте: ${formatNumber(PAPER_TRANSACTION_COST_PERCENT, 2)}% на сигнал`,
    `Лимиты paper: до ${PAPER_MAX_ACTIVE_SIGNALS} активных сигналов, дневной лимит ${PAPER_MAX_DAILY_LOSS_PERCENT}%`,
    "",
    "По акциям и направлениям:",
    ...(breakdownLines.length ? breakdownLines : ["пока нет завершённых"]),
    "",
    "По режимам IMOEX:",
    ...(regimeLines.length ? regimeLines : ["пока нет завершённых"]),
    "",
    "Последние завершённые:",
    ...(latestLines.length ? latestLines : ["пока нет"]),
    "",
    "Каждый сигнал проверяется по TP/SL и результату через 6 часов.",
  ].join("\n");
}

function historicalPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(MIN_TRADE_PERCENT, Math.abs(value));
}

function historicalMedianPercent(
  combinations: Combination[],
  direction: SignalDirection,
  field: "bestTakeProfit" | "bestStopLoss",
) {
  const values = combinations
    .filter((combination) => combination.direction === direction)
    .map((combination) => historicalPercent(combination[field]))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (!values.length) return MIN_TRADE_PERCENT;
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function directionFromCurrentFactors(feature: LatestFeature): SignalDirection {
  const bullish = [
    feature.ema20 !== null && feature.ema50 !== null && feature.ema20 > feature.ema50,
    feature.ema50 !== null && feature.ema200 !== null && feature.ema50 > feature.ema200,
    feature.macdHist !== null && feature.macdHist > 0,
    feature.vwap !== null && feature.close > feature.vwap,
    feature.acceleration !== null && feature.acceleration > 0,
    feature.priceChange5 !== null && feature.priceChange5 > 0,
    feature.rsi !== null && feature.rsi < 45,
  ].filter(Boolean).length;
  const bearish = [
    feature.ema20 !== null && feature.ema50 !== null && feature.ema20 < feature.ema50,
    feature.ema50 !== null && feature.ema200 !== null && feature.ema50 < feature.ema200,
    feature.macdHist !== null && feature.macdHist < 0,
    feature.vwap !== null && feature.close < feature.vwap,
    feature.acceleration !== null && feature.acceleration < 0,
    feature.priceChange5 !== null && feature.priceChange5 < 0,
    feature.rsi !== null && feature.rsi > 55,
  ].filter(Boolean).length;
  if (bullish === bearish) {
    return (feature.priceChange5 ?? feature.acceleration ?? feature.macdHist ?? 0) >= 0
      ? "BUY"
      : "SELL";
  }
  return bullish > bearish ? "BUY" : "SELL";
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

function combinationMatchRatio(
  feature: LatestFeature,
  combination: Combination,
  thresholds: FactorThresholds | undefined,
  professionalPatternKeys: Set<string>,
) {
  if (!thresholds || !combination.conditions.length) return 0;
  const matched = combination.conditions.reduce(
    (count, condition) =>
      count +
      (matchesCombination(
        feature,
        { ...combination, conditions: [condition] },
        thresholds,
        professionalPatternKeys,
      )
        ? 1
        : 0),
    0,
  );
  return matched / combination.conditions.length;
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
): Promise<SignalAnalysis> {
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
  const direction = directionFromCurrentFactors(feature);
  const relevant = matched.filter((combination) => combination.direction === direction);
  const relevantPatterns = matchedPatterns.filter((pattern) => pattern.direction === direction);
  const bestCombination = relevant[0] ?? null;
  const nearestHistorical = combinations
    .filter((combination) => combination.direction === direction)
    .map((combination) => ({
      combination,
      ratio: combinationMatchRatio(
        feature,
        combination,
        thresholds,
        professionalPatternKeys,
      ),
    }))
    .sort(
      (left, right) =>
        right.ratio - left.ratio ||
        evidenceScore(right.combination) - evidenceScore(left.combination),
    )[0]?.combination ?? null;
  const bestHistorical =
    topEvidence({
      direction,
      confidence: 50,
      reasons: [],
      stop: feature.close,
      target: feature.close,
      horizonMinutes: 0,
      matched: relevant,
      matchedPatterns: relevantPatterns,
      historicalEvidence: null,
      marketStructure,
    }) ??
    bestCombination ??
    nearestHistorical;
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
  const bestTakeProfit = historicalPercent(bestHistorical?.bestTakeProfit);
  const bestStopLoss = historicalPercent(bestHistorical?.bestStopLoss);
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
    historicalEvidence: bestHistorical,
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
    "Функции:",
    `«${SMART_MONEY_BUTTON}» — найти подтверждённые Smart Money SMC-сетапы.`,
    `«${COMMODITIES_BUTTON}» — анализировать золото, серебро и Brent.`,
    `«${MONEY_TEST_BUTTON}» — экспериментальный intraday-анализ с дополнительными фильтрами.`,
    `«${COMPANY_ANALYSIS_BUTTON}» — выполнить Smart Money-анализ выбранной компании.`,
    "",
    "Также доступны команды:",
    "/smartmoney — подтверждённые Smart Money SMC-сетапы.",
    "/commodities — Smart Money-анализ золота, серебра и Brent.",
    "/moneytest — экспериментальный intraday-анализ с дополнительными фильтрами.",
    "/analysis ТИКЕР — Smart Money-анализ выбранной компании.",
    "/help — показать эту справку.",
    "",
    "Все результаты работают в режиме PAPER TRADING. Реальные сделки не совершаются.",
  ].join("\n");
}

function isCompanyAnalysisRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === COMPANY_ANALYSIS_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "аналитика компании" ||
    normalizedText === "анализ компании" ||
    normalizedText === "/analysis" ||
    normalizedText === "/analyze" ||
    normalizedText === "/company"
  );
}

function normalizeTickerArgument(value: string | undefined) {
  return value?.toUpperCase().replace(/[^A-Z0-9_]/g, "") ?? "";
}

function isSmartMoneyRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === SMART_MONEY_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "smart money" ||
    normalizedText === "смарт мани" ||
    normalizedText === "/smartmoney"
  );
}

function isCommoditiesRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === COMMODITIES_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "сырьё и металлы" ||
    normalizedText === "сырье и металлы" ||
    normalizedText === "сырье" ||
    normalizedText === "металлы" ||
    normalizedText === "/commodities" ||
    normalizedText === "/commodity"
  );
}

function isMoneyTestRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === MONEY_TEST_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "деньги тест" ||
    normalizedText === "money test" ||
    normalizedText === "/moneytest" ||
    normalizedText === "/money_test"
  );
}

function isIntradayRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === INTRADAY_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "внутри дня" ||
    normalizedText === "внутридневная торговля" ||
    normalizedText === "/intraday"
  );
}

function isWavesRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === WAVES_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "волновой анализ" ||
    normalizedText === "волны эллиотта" ||
    normalizedText === "/waves"
  );
}

function isWaveStatsRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === WAVE_STATS_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "статистика волн" ||
    normalizedText === "/wave_stats"
  );
}

function intradayCandidateText(candidate: IntradayCandidate, index: number) {
  const isLong = candidate.direction === "BUY";
  const marketEntry = isLong ? candidate.quote.offer : candidate.quote.bid;
  if (marketEntry === null) return null;
  const target = isLong
    ? marketEntry * (1 + candidate.targetPercent / 100)
    : marketEntry * (1 - candidate.targetPercent / 100);
  const stop = isLong
    ? marketEntry * (1 - candidate.stopPercent / 100)
    : marketEntry * (1 + candidate.stopPercent / 100);
  const netTargetPercent = candidate.targetPercent - PAPER_TRANSACTION_COST_PERCENT;
  return [
    `${index}. ${candidate.ticker} — ${isLong ? "LONG" : "SHORT"}`,
    `Сила внутридневного сетапа: ${candidate.score}/100`,
    `Текущая цена: ${formatNumber(candidate.quote.last)}`,
    `Вход ${isLong ? "Ask" : "Bid"}: ${formatNumber(marketEntry)}`,
    `Take profit: ${formatNumber(target)} (${isLong ? "+" : "-"}${formatNumber(candidate.targetPercent)}%)`,
    `Stop loss: ${formatNumber(stop)} (${isLong ? "-" : "+"}${formatNumber(candidate.stopPercent)}%)`,
    `Чистый потенциал после издержек: ${isLong ? "+" : "-"}${formatNumber(netTargetPercent)}%`,
    `Спред: ${formatNumber(candidate.spreadPercent, 3)}%`,
    candidate.currentChangePercent === null
      ? "Изменение от последней свечи: —"
      : `Изменение от последней свечи: ${candidate.currentChangePercent >= 0 ? "+" : ""}${formatNumber(candidate.currentChangePercent)}%`,
    `Свеча индикаторов: ${formatDate(candidate.feature.timestamp)}`,
    "Причины:",
    ...candidate.reasons.map((reason) => `• ${reason}`),
    "Стакан: не используется — публичный MOEX endpoint не отдал orderbook",
    "Режим: PAPER TRADING — реальные сделки не совершаются",
  ].join("\n");
}

function smartMoneyCandidateText(candidate: SmartMoneyCandidate, index: number) {
  const isLong = candidate.direction === "BUY";
  const direction = isLong ? "LONG" : "SHORT";
  const sign = isLong ? "+" : "-";
  const stopSign = isLong ? "-" : "+";
  return [
    `${index}. ${isLong ? "📈" : "📉"} ${direction} · ${candidate.ticker}`,
    `Рейтинг: ${candidate.score}/100 · адаптивный порог: ${candidate.threshold}`,
    `Вероятность сетапа: ${candidate.probability}%`,
    `Таймфреймы: ${candidate.timeframe}`,
    "",
    `Вход: ${formatNumber(candidate.entryPrice)}`,
    `Stop Loss: ${formatNumber(candidate.stopPrice)} (${stopSign}${formatNumber(Math.abs((candidate.stopPrice - candidate.entryPrice) / candidate.entryPrice * 100), 2)}%)`,
    `Take Profit 1: ${formatNumber(candidate.takeProfit1)} (${sign}${formatNumber(Math.abs((candidate.takeProfit1 - candidate.entryPrice) / candidate.entryPrice * 100), 2)}%)`,
    `Take Profit 2: ${formatNumber(candidate.takeProfit2)} (${sign}${formatNumber(Math.abs((candidate.takeProfit2 - candidate.entryPrice) / candidate.entryPrice * 100), 2)}%)`,
    `Take Profit 3: ${formatNumber(candidate.takeProfit3)} (${sign}${formatNumber(Math.abs((candidate.takeProfit3 - candidate.entryPrice) / candidate.entryPrice * 100), 2)}%)`,
    `Risk / Reward: 1:${formatNumber(candidate.rewardRisk, 2)}`,
    `Net R:R после комиссий/проскальзывания: 1:${formatNumber(candidate.netRewardRisk, 2)}`,
    "",
    `Накопление: ${candidate.accumulation.strength} · ${candidate.accumulation.score} баллов`,
    `Диапазон накопления: ${formatNumber(candidate.accumulation.rangeLow)}–${formatNumber(candidate.accumulation.rangeHigh)}`,
    `Сжатие ATR: ${formatNumber(candidate.accumulation.atrCompression * 100, 0)}% · тестов уровня: ${candidate.accumulation.levelTests}`,
    `Структура: ${candidate.structure.bos ?? "BOS"} · ${candidate.structure.choch ?? "CHoCH"}`,
    `Ликвидность: ${candidate.liquidity.length ? candidate.liquidity.join(", ") : "подтверждена структурой"}`,
    `Order Block: ${candidate.orderBlock ?? "не найден"}`,
    `FVG: ${candidate.fairValueGap ?? "не найден"}`,
    `Объём: ${candidate.volumeConfirmed ? "подтверждён" : "не подтверждён"} · ретест: ${candidate.retestConfirmed ? "подтверждён" : "не подтверждён"}`,
    `Согласование старших ТФ: ${candidate.higherTimeframeAgreement.join(", ")}`,
    `Режим IMOEX: ${candidate.marketRegime === "BUY" ? "сильный рынок" : candidate.marketRegime === "SELL" ? "слабый рынок" : "нейтральный"}`,
    `Импульс BOS: ${candidate.impulseConfirmed ? "подтверждён" : "слабый"} · ${formatNumber(candidate.bosQuality, 2)} ATR`,
    `Размер сигнальной свечи: ${formatNumber(candidate.rangeToAtr, 2)} ATR`,
    "",
    "Причины:",
    ...candidate.reasons.map((reason) => `✅ ${reason}`),
    "",
    "График close / уровни:",
    candidate.chart,
    "",
    `Свеча: ${formatDate(candidate.timestamp)}`,
    "Режим: PAPER TRADING — реальные деньги не используются.",
    "Сигнал не является финансовой рекомендацией.",
  ].join("\n");
}

function commodityName(ticker: string) {
  if (ticker === "XAUUSD") return "Золото";
  if (ticker === "XAGUSD") return "Серебро";
  if (ticker === "BRENT") return "Нефть Brent";
  return ticker;
}

async function refreshCommodityData() {
  if (latestCommodityRefresh) return latestCommodityRefresh;
  latestCommodityRefresh = (async () => {
    const latest = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE timeframe = '1h')::int AS hourly_count,
        MAX(timestamp) FILTER (WHERE timeframe = '1h') AS hourly_latest
      FROM candles
      WHERE ticker IN ('XAUUSD', 'XAGUSD', 'BRENT')
    `);
    const row = (latest.rows[0] ?? {}) as Record<string, unknown>;
    const rawLatest = row.hourly_latest;
    const latestTimestamp =
      rawLatest instanceof Date ? rawLatest : rawLatest ? new Date(String(rawLatest)) : null;
    const hourlyFresh =
      latestTimestamp !== null &&
      Number.isFinite(latestTimestamp.getTime()) &&
      Date.now() - latestTimestamp.getTime() <= 3 * 60 * 60_000;
    const timeframes = Number(row.hourly_count) >= 60 && hourlyFresh ? "1m" : "1m,1h";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "--filter",
          "@workspace/scripts",
          "run",
          "download-commodities",
          "--",
          `--timeframes=${timeframes}`,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        logger.info({ output: chunk.toString().trim() }, "Commodity data refresh output");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logger.warn({ output: chunk.toString().trim() }, "Commodity data refresh error output");
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `Commodity refresh exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
            ),
          );
        }
      });
    });
  })().finally(() => {
    latestCommodityRefresh = null;
  });
  return latestCommodityRefresh;
}

async function latestCommodityQuotes() {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (ticker)
      ticker, close, timestamp
    FROM candles
    WHERE ticker IN ('XAUUSD', 'XAGUSD', 'BRENT')
      AND timeframe = '1m'
    ORDER BY ticker, timestamp DESC
  `);
  return result.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        ticker: String(row.ticker),
        close: Number(row.close),
        timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp)),
      };
    })
    .filter((row) => Number.isFinite(row.close) && Number.isFinite(row.timestamp.getTime()));
}

async function recordCommodityCandidates(candidates: SmartMoneyCandidate[]) {
  let recorded = 0;
  let duplicates = 0;
  let blocked = 0;
  const recordedCandidates: SmartMoneyCandidate[] = [];
  for (const candidate of candidates) {
    const result = await recordPaperSignal({
      ticker: candidate.ticker,
      featureTimestamp: candidate.timestamp,
      direction: candidate.direction,
      confidence: candidate.score,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
      targetPrice: candidate.takeProfit2,
      horizonMinutes: 360,
      reasons: candidate.reasons,
      patternIds: [],
      combinationIds: [],
      source: "commodity-smartmoney",
      timeframe: "15m",
      bypassRiskLimits: true,
      metadata: {
        smartMoney: true,
        commodity: true,
        timeframe: "15m",
        setupTimeframe: "15m",
        executionTimeframe: "1m",
        strategy: "SMC-Accumulation-BOS-CHoCH-Commodities",
        probability: candidate.probability,
        adaptiveThreshold: candidate.threshold,
        rewardRisk: candidate.rewardRisk,
        netRewardRisk: candidate.netRewardRisk,
        takeProfit1: candidate.takeProfit1,
        takeProfit2: candidate.takeProfit2,
        takeProfit3: candidate.takeProfit3,
        accumulation: candidate.accumulation,
        structure: candidate.structure,
        liquidity: candidate.liquidity,
        orderBlock: candidate.orderBlock,
        fairValueGap: candidate.fairValueGap,
        volumeConfirmed: candidate.volumeConfirmed,
        retestConfirmed: candidate.retestConfirmed,
        higherTimeframeAgreement: candidate.higherTimeframeAgreement,
        marketRegime: candidate.marketRegime,
        bosQuality: candidate.bosQuality,
        impulseConfirmed: candidate.impulseConfirmed,
        rangeToAtr: candidate.rangeToAtr,
        chart: candidate.chart,
      },
    });
    if (result === "recorded") {
      recorded += 1;
      recordedCandidates.push(candidate);
    }
    else if (result === "duplicate") duplicates += 1;
    else blocked += 1;
  }
  return { recorded, duplicates, blocked, recordedCandidates };
}

function commodityQuoteText(
  quote: { ticker: string; close: number; timestamp: Date },
) {
  return `${commodityName(quote.ticker)} (${quote.ticker}): ${formatNumber(quote.close)} · ${formatDate(quote.timestamp)}`;
}

async function commoditiesText(chatId?: number): Promise<TelegramMessage> {
  if (chatId !== undefined) await subscribeCommodityChat(chatId);
  try {
    await refreshCommodityData();
    const [scan, quotes] = await Promise.all([
      scanSmartMoney(undefined, {
        universe: "commodities",
        source: "commodity-smartmoney",
      }),
      latestCommodityQuotes(),
    ]);
    const records = await recordCommodityCandidates(scan.candidates);
    const blocks = scan.candidates.map((candidate, index) =>
      smartMoneyCandidateText(candidate, index + 1),
    );
    return {
      text: [
        "🪙 СЫРЬЁ И МЕТАЛЛЫ · SMART MONEY",
        "",
        "Мировые котировки:",
        ...(quotes.length ? quotes.map(commodityQuoteText) : ["Котировки пока недоступны."]),
        "",
        `Проверено инструментов: ${scan.analyzed} · обновлено: ${formatDate(scan.generatedAt)}`,
        `Адаптивный минимальный рейтинг: ${formatNumber(scan.threshold, 0)}/100`,
        "Логика: та же, что в Smart Money — накопление, BOS, CHoCH, ликвидность, Order Block, FVG, объём, HTF alignment и net R:R.",
        `Новых paper-сигналов: ${records.recorded} · повторов: ${records.duplicates}`,
        "",
        ...(blocks.length
          ? blocks.flatMap((block) => [block, ""])
          : ["Свежих сетапов по золоту, серебру и Brent сейчас нет.", ""]),
        "Мониторинг: рынок обновляется примерно каждые 3 минуты.",
        "При развороте структуры, потере объёма, достижении цели или стопа бот отправит уведомление о сокращении или выходе.",
        "PAPER TRADING — реальные сделки не совершаются. Не финансовая рекомендация.",
      ].join("\n"),
      replyMarkup: TELEGRAM_MENU,
    };
  } catch (error) {
    logger.error({ err: error }, "Commodity Smart Money scan failed");
    return {
      text: [
        "🪙 СЫРЬЁ И МЕТАЛЛЫ · SMART MONEY",
        "",
        "Не удалось обновить мировые котировки.",
        "Сигналы не формирую, чтобы не использовать неполные или устаревшие данные.",
      ].join("\n"),
      replyMarkup: TELEGRAM_MENU,
    };
  }
}

async function recordMoneyTestCandidates(
  candidates: SmartMoneyCandidate[],
  marketDirection: "BUY" | "SELL" | "NEUTRAL",
) {
  let recorded = 0;
  let duplicates = 0;
  let blocked = 0;
  const recordedCandidates: SmartMoneyCandidate[] = [];
  for (const candidate of candidates) {
    const result = await recordPaperSignal({
      ticker: candidate.ticker,
      featureTimestamp: candidate.timestamp,
      direction: candidate.direction,
      confidence: candidate.score,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
      targetPrice: candidate.takeProfit2,
      horizonMinutes: 360,
      reasons: candidate.reasons,
      patternIds: [],
      combinationIds: [],
      source: "money-test",
      timeframe: "15m",
      bypassRiskLimits: true,
      metadata: {
        smartMoney: true,
        moneyTest: true,
        timeframe: "15m",
        setupTimeframe: "15m",
        executionTimeframe: "1m",
        strategy: "Money-Test-SMC-Intraday",
        probability: candidate.probability,
        adaptiveThreshold: candidate.threshold,
        rewardRisk: candidate.rewardRisk,
        netRewardRisk: candidate.netRewardRisk,
        takeProfit1: candidate.takeProfit1,
        takeProfit2: candidate.takeProfit2,
        takeProfit3: candidate.takeProfit3,
        accumulation: candidate.accumulation,
        structure: candidate.structure,
        liquidity: candidate.liquidity,
        orderBlock: candidate.orderBlock,
        fairValueGap: candidate.fairValueGap,
        volumeConfirmed: candidate.volumeConfirmed,
        retestConfirmed: candidate.retestConfirmed,
        higherTimeframeAgreement: candidate.higherTimeframeAgreement,
        marketRegime: candidate.marketRegime,
        bosQuality: candidate.bosQuality,
        impulseConfirmed: candidate.impulseConfirmed,
        rangeToAtr: candidate.rangeToAtr,
        marketDirectionAtEntry: marketDirection,
        chart: candidate.chart,
      },
    });
    if (result === "recorded") {
      recorded += 1;
      recordedCandidates.push(candidate);
    } else if (result === "duplicate") duplicates += 1;
    else blocked += 1;
  }
  return { recorded, duplicates, blocked, recordedCandidates };
}

async function moneyTestText(chatId?: number): Promise<TelegramMessage> {
  if (chatId !== undefined) await subscribeMoneyTestChat(chatId);
  try {
    await ensureSmartMoneyDataFresh();
    await ensureSmartMoneyHigherTimeframes(false);
    const scan = await scanMoneyTest();
    const records = await recordMoneyTestCandidates(scan.candidates, scan.market.direction);
    const marketDirection =
      scan.market.direction === "BUY"
        ? "бычий"
        : scan.market.direction === "SELL"
          ? "медвежий"
          : "нейтральный";
    const blocks = scan.candidates.map((candidate, index) =>
      smartMoneyCandidateText(candidate, index + 1),
    );
    const rejectedPreview = scan.rejected
      .slice(0, 5)
      .map(({ ticker, reasons }) => `${ticker}: ${reasons[0]}`)
      .join("; ");
    const tickerDiagnostics = scan.diagnostics.map((item) => {
      const stage =
        item.stage === "passed"
          ? "ПРОШЛА"
          : item.stage === "test-filter-rejected"
            ? "отсечена фильтрами теста"
            : "отсечена базовым SMC";
      const reasons = [...item.reasons, ...item.extraReasons].slice(0, 2).join(" ");
      return `${item.name} (${item.ticker}): ${stage}. ${reasons}`;
    });
    return {
      text: [
        "💵 ДЕНЬГИ ТЕСТ · ЭКСПЕРИМЕНТАЛЬНЫЙ INTRADAY SMC",
        "",
        `Проверено акций: ${scan.base.analyzed} · обновлено: ${formatDate(scan.generatedAt)}`,
        `Режим рынка: ${marketDirection} · breadth: ${formatNumber(scan.market.breadthPercent, 1)}%`,
        `Растут: ${scan.market.advancers} · снижаются: ${scan.market.decliners} · без изменения: ${scan.market.unchanged}`,
        `Торговое окно: ${scan.market.inTradeWindow ? "активно" : "неактивно"} · ${scan.market.sessionLabel}`,
        "",
        "Новые фильтры теста: время сессии, ширина рынка, точка входа возле OB/FVG или ретест, объём и текущая ликвидность.",
        "Этап 1 — базовый SMC: накопление, BOS, CHoCH/альтернативное подтверждение, объём, HTF, импульс, R:R и рейтинг.",
        "Этап 2 — фильтры ДЕНЬГИ ТЕСТ: торговое окно, breadth, качество входа и ликвидность.",
        `Кандидатов после экспериментальных фильтров: ${scan.candidates.length}`,
        `Новых paper-сигналов: ${records.recorded} · повторов: ${records.duplicates}`,
        "",
        "Проверка добавленных компаний:",
        ...tickerDiagnostics,
        "",
        rejectedPreview
          ? `Примеры отсева: ${rejectedPreview}`
          : "Дополнительных отсеянных кандидатов нет.",
        "",
        ...(blocks.length
          ? blocks.flatMap((block) => [block, ""])
          : [
              "Свежих тестовых сетапов сейчас нет.",
              "",
              "Это не означает отсутствие движения: только базовый SMC-сетап, рыночный контекст и качество входа должны совпасть одновременно.",
              "",
            ]),
        "Проверка рынка и открытых paper-позиций: каждые 2 минуты.",
        "При потере структуры, объёма, ликвидности или развороте рынка бот отправит REDUCE либо EXIT.",
        "Контрольная группа: обычный раздел Smart Money не изменяется.",
        "PAPER TRADING — реальные сделки не совершаются. Не финансовая рекомендация.",
      ].join("\n"),
      replyMarkup: TELEGRAM_MENU,
    };
  } catch (error) {
    logger.error({ err: error }, "Money Test scan failed");
    return {
      text: [
        "💵 ДЕНЬГИ ТЕСТ · ЭКСПЕРИМЕНТАЛЬНЫЙ INTRADAY SMC",
        "",
        "Не удалось завершить экспериментальный скан.",
        "Сигналы не формирую, чтобы не использовать неполные или устаревшие данные.",
      ].join("\n"),
      replyMarkup: TELEGRAM_MENU,
    };
  }
}

type MoneyTestMonitorEvent = {
  kind: "REDUCE" | "EXIT";
  reason: string;
  price: number;
  timestamp: Date;
};

function moneyTestMonitorMessage(
  ticker: string,
  direction: string,
  event: MoneyTestMonitorEvent,
) {
  return [
    `🚨 ДЕНЬГИ ТЕСТ · ${event.kind === "EXIT" ? "ПОЛНЫЙ ВЫХОД" : "СОКРАТИТЬ ПОЗИЦИЮ"}`,
    "",
    `${ticker} · ${direction === "BUY" ? "LONG" : "SHORT"}`,
    `Цена: ${formatNumber(event.price)}`,
    `Причина: ${event.reason}`,
    `Время: ${formatDate(event.timestamp)}`,
    "",
    event.kind === "EXIT"
      ? "Экспериментальный сценарий больше не подтверждается. Для paper-позиции зафиксирован полный выход."
      : "Сценарий ослабевает. Для paper-позиции зафиксировано сокращение позиции и ужесточение защиты.",
    "Рабочий Smart Money-раздел не затронут.",
    "PAPER TRADING — реальные сделки не совершаются. Не финансовая рекомендация.",
  ].join("\n");
}

async function runMoneyTestPositionMonitor(scan: MoneyTestScan) {
  const liveDirections = new Map(
    scan.base.diagnostics.map((diagnostic) => [diagnostic.ticker, diagnostic.direction]),
  );
  const active = await db.execute(sql`
    SELECT id, ticker, direction, entry_price, stop_price, metadata
    FROM signals_history
    WHERE outcome IS NULL
      AND metadata ->> 'source' = 'money-test'
    ORDER BY id
  `);
  for (const raw of active.rows) {
    const row = raw as Record<string, unknown>;
    const id = Number(row.id);
    const ticker = String(row.ticker);
    const direction = String(row.direction);
    const entry = Number(row.entry_price);
    const stop = Number(row.stop_price);
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const latest = await db.execute(sql`
      SELECT timestamp, high, low, close, volume
      FROM candles
      WHERE ticker = ${ticker} AND timeframe = '1m'
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const candle = latest.rows[0] as Record<string, unknown> | undefined;
    if (!candle) continue;
    const timestamp =
      candle.timestamp instanceof Date ? candle.timestamp : new Date(String(candle.timestamp));
    const price = Number(candle.close);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const volume = Number(candle.volume);
    if (
      !Number.isFinite(id) ||
      !Number.isFinite(entry) ||
      !Number.isFinite(stop) ||
      !Number.isFinite(price) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(volume) ||
      !Number.isFinite(timestamp.getTime())
    ) {
      continue;
    }
    const target1 = Number(metadata.takeProfit1);
    const target2 = Number(metadata.takeProfit2);
    const target3 = Number(metadata.takeProfit3);
    const lastEvent = String(metadata.moneyTestLastEvent ?? "");
    const entryMarketDirection = String(metadata.marketDirectionAtEntry ?? "NEUTRAL");
    const currentMarketDirection = scan.market.direction;
    const volumeWindowStart = new Date(timestamp.getTime() - 20 * 60_000);
    const volumeBaselineStart = new Date(timestamp.getTime() - 4 * 60 * 60_000);
    const volumeStats = await db.execute(sql`
      SELECT
        AVG(volume) FILTER (WHERE timestamp >= ${volumeWindowStart}) AS recent_volume,
        AVG(volume) FILTER (
          WHERE timestamp < ${volumeWindowStart}
            AND timestamp >= ${volumeBaselineStart}
        ) AS baseline_volume
      FROM candles
      WHERE ticker = ${ticker}
        AND timeframe = '1m'
        AND timestamp >= ${volumeBaselineStart}
        AND timestamp <= ${timestamp}
    `);
    const volumeRow = (volumeStats.rows[0] ?? {}) as Record<string, unknown>;
    const recentVolume = Number(volumeRow.recent_volume);
    const baselineVolume = Number(volumeRow.baseline_volume);
    const volumeRatio =
      Number.isFinite(recentVolume) &&
      Number.isFinite(baselineVolume) &&
      baselineVolume > 0
        ? recentVolume / baselineVolume
        : null;
    let event: MoneyTestMonitorEvent | null = null;
    if ((direction === "BUY" && low <= stop) || (direction === "SELL" && high >= stop)) {
      event = {
        kind: "EXIT",
        reason: `достигнут Stop Loss ${formatNumber(stop)}`,
        price,
        timestamp,
      };
    } else if (
      (currentMarketDirection === "BUY" && direction === "SELL") ||
      (currentMarketDirection === "SELL" && direction === "BUY")
    ) {
      event = {
        kind: "EXIT",
        reason: `ширина рынка развернулась против позиции: ${currentMarketDirection === "BUY" ? "BUY" : "SELL"}`,
        price,
        timestamp,
      };
    } else if (
      currentMarketDirection === "NEUTRAL" &&
      (entryMarketDirection === "BUY" || entryMarketDirection === "SELL") &&
      lastEvent !== "market_reduce"
    ) {
      event = {
        kind: "REDUCE",
        reason: "ширина рынка перешла в нейтральную фазу",
        price,
        timestamp,
      };
    } else if (volumeRatio !== null && volumeRatio < 0.65 && lastEvent !== "volume_reduce") {
      event = {
        kind: "REDUCE",
        reason: `объём/ликвидность снизились до ${volumeRatio.toFixed(2)}x базового уровня`,
        price,
        timestamp,
      };
    } else if (liveDirections.get(ticker) === null) {
      event = {
        kind: "EXIT",
        reason: "базовая SMC-структура больше не подтверждается",
        price,
        timestamp,
      };
    } else if (
      liveDirections.get(ticker) &&
      liveDirections.get(ticker) !== direction
    ) {
      event = {
        kind: "EXIT",
        reason: `направление структуры развернулось в ${liveDirections.get(ticker) === "BUY" ? "LONG" : "SHORT"}`,
        price,
        timestamp,
      };
    } else if (
      Number.isFinite(target3) &&
      ((direction === "BUY" && high >= target3) || (direction === "SELL" && low <= target3)) &&
      lastEvent !== "tp3_exit"
    ) {
      event = {
        kind: "EXIT",
        reason: `достигнут Take Profit 3 ${formatNumber(target3)}`,
        price,
        timestamp,
      };
    } else if (
      Number.isFinite(target2) &&
      ((direction === "BUY" && high >= target2) || (direction === "SELL" && low <= target2)) &&
      !["tp2_reduce", "tp3_exit"].includes(lastEvent)
    ) {
      event = {
        kind: "REDUCE",
        reason: `достигнут Take Profit 2 ${formatNumber(target2)}`,
        price,
        timestamp,
      };
    } else if (
      Number.isFinite(target1) &&
      ((direction === "BUY" && high >= target1) || (direction === "SELL" && low <= target1)) &&
      !["tp1_reduce", "tp2_reduce", "tp3_exit"].includes(lastEvent)
    ) {
      event = {
        kind: "REDUCE",
        reason: `достигнут Take Profit 1 ${formatNumber(target1)}`,
        price,
        timestamp,
      };
    }
    if (!event) continue;
    const eventKey =
      event.kind === "EXIT"
        ? event.reason.includes("Take Profit 3")
          ? "tp3_exit"
          : "exit"
        : event.reason.includes("Take Profit 2")
          ? "tp2_reduce"
          : event.reason.includes("объём/ликвидность")
            ? "volume_reduce"
          : event.reason.includes("ширина рынка")
            ? "market_reduce"
          : "tp1_reduce";
    const updated = await db.execute(sql`
      UPDATE signals_history
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
        moneyTestLastEvent: eventKey,
        moneyTestLastEventAt: timestamp.toISOString(),
        moneyTestLastEventReason: event.reason,
      })}::jsonb
      WHERE id = ${id}
        AND outcome IS NULL
        AND COALESCE(metadata ->> 'moneyTestLastEvent', '') <> ${eventKey}
      RETURNING id
    `);
    if (!updated.rows.length) continue;
    if (event.kind === "EXIT") {
      const gross =
        direction === "BUY"
          ? ((price - entry) / entry) * 100
          : ((entry - price) / entry) * 100;
      await db.execute(sql`
        UPDATE signals_history
        SET outcome = 'EXIT',
            outcome_percent = ${gross - PAPER_TRANSACTION_COST_PERCENT},
            outcome_at = ${timestamp}
        WHERE id = ${id}
          AND outcome IS NULL
      `);
    }
    if (!moneyTestNotifier) continue;
    const message = moneyTestMonitorMessage(ticker, direction, event);
    for (const chatId of moneyTestChatIds) {
      await moneyTestNotifier(chatId, message);
    }
  }
}

async function runMoneyTestScanCycle() {
  if (moneyTestScanRunning) return;
  moneyTestScanRunning = true;
  try {
    await refreshLatestIntradayData();
    await ensureSmartMoneyHigherTimeframes(false);
    const scan = await scanMoneyTest();
    const records = await recordMoneyTestCandidates(
      scan.candidates,
      scan.market.direction,
    );
    if (moneyTestNotifier && records.recordedCandidates.length) {
      for (const candidate of records.recordedCandidates) {
        const message = [
          "💵 НОВЫЙ СИГНАЛ · ДЕНЬГИ ТЕСТ",
          "",
          smartMoneyCandidateText(candidate, 1),
        ].join("\n");
        for (const chatId of moneyTestChatIds) {
          await moneyTestNotifier(chatId, message);
        }
      }
    }
    await runMoneyTestPositionMonitor(scan);
    logger.info(
      {
        analyzed: scan.base.analyzed,
        baseCandidates: scan.base.candidates.length,
        candidates: scan.candidates.length,
        recorded: records.recorded,
        duplicates: records.duplicates,
      },
      "Money Test scan cycle completed",
    );
  } catch (error) {
    logger.warn({ err: error }, "Money Test scan cycle skipped");
  } finally {
    moneyTestScanRunning = false;
  }
}

type CommodityMonitorEvent = {
  kind: "REDUCE" | "EXIT";
  reason: string;
  price: number;
  timestamp: Date;
};

function commodityMonitorMessage(
  ticker: string,
  event: CommodityMonitorEvent,
  direction: string,
) {
  const action = event.kind === "EXIT" ? "ПОЛНОСТЬЮ ВЫЙТИ" : "СОКРАТИТЬ ПОЗИЦИЮ";
  return [
    `🚨 СЫРЬЁ И МЕТАЛЛЫ · ${action}`,
    "",
    `${commodityName(ticker)} (${ticker}) · ${direction === "BUY" ? "LONG" : "SHORT"}`,
    `Цена: ${formatNumber(event.price)}`,
    `Причина: ${event.reason}`,
    `Время: ${formatDate(event.timestamp)}`,
    "",
    event.kind === "EXIT"
      ? "Сценарий Smart Money потерял актуальность. Для paper-позиции зафиксирована рекомендация полного выхода."
      : "Импульс ослабевает. Для paper-позиции зафиксирована рекомендация сократить объём и подтянуть защиту.",
    "PAPER TRADING — реальные сделки не совершаются. Не финансовая рекомендация.",
  ].join("\n");
}

async function commodityMonitorEvent(
  ticker: string,
  price: number,
  timestamp: Date,
  direction: string,
  metadata: Record<string, unknown>,
  liveDirection: string | null | undefined,
  volumeRatio: number | null,
): Promise<CommodityMonitorEvent | null> {
  const stop = Number(metadata.stopPrice);
  const target1 = Number(metadata.takeProfit1);
  const target2 = Number(metadata.takeProfit2);
  const target3 = Number(metadata.takeProfit3);
  const entry = Number(metadata.entryPrice);
  const structure =
    metadata.structure && typeof metadata.structure === "object"
      ? (metadata.structure as Record<string, unknown>)
      : {};
  const structureDirection =
    liveDirection === "BUY" || liveDirection === "SELL"
      ? liveDirection
      : structure.direction === "BUY" || structure.direction === "SELL"
        ? String(structure.direction)
        : direction;
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(target1) ||
    !Number.isFinite(target2) ||
    !Number.isFinite(target3) ||
    !Number.isFinite(entry)
  ) {
    return null;
  }

  if (direction === "BUY" && price <= stop) {
    return { kind: "EXIT", reason: `достигнут Stop Loss ${formatNumber(stop)}`, price, timestamp };
  }
  if (direction === "SELL" && price >= stop) {
    return { kind: "EXIT", reason: `достигнут Stop Loss ${formatNumber(stop)}`, price, timestamp };
  }
  if (liveDirection === null) {
    return {
      kind: "EXIT",
      reason: "Smart Money-структура больше не подтверждается",
      price,
      timestamp,
    };
  }
  if (liveDirection !== undefined && structureDirection !== direction) {
    return {
      kind: "EXIT",
      reason: `разворот структуры: направление стало ${structureDirection === "BUY" ? "LONG" : "SHORT"}`,
      price,
      timestamp,
    };
  }

  const lastEvent = String(metadata.commodityLastEvent ?? "");
  if (volumeRatio !== null && volumeRatio < 0.65 && lastEvent !== "volume_reduce") {
    return {
      kind: "REDUCE",
      reason: `объём снизился до ${formatNumber(volumeRatio, 2)}x среднего 15m объёма`,
      price,
      timestamp,
    };
  }
  if (
    (direction === "BUY" && price >= target3) ||
    (direction === "SELL" && price <= target3)
  ) {
    if (lastEvent !== "tp3_exit") {
      return { kind: "EXIT", reason: `достигнут Take Profit 3 ${formatNumber(target3)}`, price, timestamp };
    }
    return null;
  }
  if (
    (direction === "BUY" && price >= target2) ||
    (direction === "SELL" && price <= target2)
  ) {
    if (!["tp2_reduce", "tp3_exit"].includes(lastEvent)) {
      return { kind: "REDUCE", reason: `достигнут Take Profit 2 ${formatNumber(target2)}`, price, timestamp };
    }
  }
  if (
    (direction === "BUY" && price >= target1) ||
    (direction === "SELL" && price <= target1)
  ) {
    if (!["tp1_reduce", "tp2_reduce", "tp3_exit"].includes(lastEvent)) {
      return { kind: "REDUCE", reason: `достигнут Take Profit 1 ${formatNumber(target1)}`, price, timestamp };
    }
  }
  return null;
}

async function runCommodityPositionMonitor() {
  const liveScan = await scanSmartMoney(undefined, {
    universe: "commodities",
    source: "commodity-smartmoney",
    skipCooldown: true,
  });
  const liveDirections = new Map<string, string | null>(
    liveScan.diagnostics
      .map((item) => [item.ticker, item.direction]),
  );
  const active = await db.execute(sql`
    SELECT id, ticker, direction, entry_price, stop_price, metadata
    FROM signals_history
    WHERE outcome IS NULL
      AND metadata ->> 'source' = 'commodity-smartmoney'
    ORDER BY id
  `);
  for (const raw of active.rows) {
    const row = raw as Record<string, unknown>;
    const id = Number(row.id);
    const ticker = String(row.ticker);
    const direction = String(row.direction);
    const entryPrice = Number(row.entry_price);
    const stopPrice = Number(row.stop_price);
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const latest = await db.execute(sql`
      SELECT timestamp, close
      FROM candles
      WHERE ticker = ${ticker} AND timeframe = '1m'
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const candle = latest.rows[0] as Record<string, unknown> | undefined;
    if (!candle) continue;
    const timestamp =
      candle.timestamp instanceof Date ? candle.timestamp : new Date(String(candle.timestamp));
    const price = Number(candle.close);
    if (!Number.isFinite(id) || !Number.isFinite(price) || !Number.isFinite(timestamp.getTime())) {
      continue;
    }
    const volumeRows = await db.execute(sql`
      SELECT timestamp, volume
      FROM candles
      WHERE ticker = ${ticker} AND timeframe = '1m'
      ORDER BY timestamp DESC
      LIMIT 360
    `);
    const volumeBuckets = new Map<number, number>();
    for (const rawVolume of volumeRows.rows) {
      const volumeRow = rawVolume as Record<string, unknown>;
      const volumeTimestamp =
        volumeRow.timestamp instanceof Date
          ? volumeRow.timestamp
          : new Date(String(volumeRow.timestamp));
      const volume = Number(volumeRow.volume) || 0;
      if (!Number.isFinite(volumeTimestamp.getTime())) continue;
      const bucket = Math.floor(volumeTimestamp.getTime() / (15 * 60_000)) * 15 * 60_000;
      volumeBuckets.set(bucket, (volumeBuckets.get(bucket) ?? 0) + volume);
    }
    const volumeValues = [...volumeBuckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, volume]) => volume);
    const latestVolume = volumeValues.at(-1) ?? null;
    const volumeBaseline = volumeValues.length > 1
      ? volumeValues.slice(-21, -1).reduce((sum, value) => sum + value, 0) /
        Math.min(20, volumeValues.length - 1)
      : null;
    const volumeRatio =
      latestVolume !== null && volumeBaseline !== null && volumeBaseline > 0
        ? latestVolume / volumeBaseline
        : null;
    const event = await commodityMonitorEvent(
      ticker,
      price,
      timestamp,
      direction,
      {
        ...metadata,
        entryPrice,
        stopPrice,
      },
      liveDirections.has(ticker) ? liveDirections.get(ticker) : undefined,
      volumeRatio,
    );
    if (!event) continue;
    const eventKey =
      event.kind === "EXIT"
        ? event.reason.includes("Take Profit 3")
          ? "tp3_exit"
          : "exit"
        : event.reason.includes("Take Profit 2")
          ? "tp2_reduce"
        : event.reason.includes("объём")
          ? "volume_reduce"
          : "tp1_reduce";
    const updated = await db.execute(sql`
      UPDATE signals_history
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
        commodityLastEvent: eventKey,
        commodityLastEventAt: event.timestamp.toISOString(),
        commodityLastEventReason: event.reason,
      })}::jsonb
      WHERE id = ${id}
        AND outcome IS NULL
        AND COALESCE(metadata ->> 'commodityLastEvent', '') <> ${eventKey}
      RETURNING id
    `);
    if (!updated.rows.length) continue;
    if (event.kind === "EXIT") {
      const grossOutcomePercent =
        direction === "BUY"
          ? ((price - entryPrice) / entryPrice) * 100
          : ((entryPrice - price) / entryPrice) * 100;
      await db.execute(sql`
        UPDATE signals_history
        SET outcome = 'EXIT',
            outcome_percent = ${grossOutcomePercent - PAPER_TRANSACTION_COST_PERCENT},
            outcome_at = ${timestamp}
        WHERE id = ${id}
          AND outcome IS NULL
      `);
    }
    if (!commodityNotifier) continue;
    const message = commodityMonitorMessage(ticker, event, direction);
    for (const chatId of commodityChatIds) {
      await commodityNotifier(chatId, message);
    }
  }
}

async function runCommodityScanCycle() {
  if (commodityScanRunning) return;
  commodityScanRunning = true;
  try {
    await refreshCommodityData();
    const scan = await scanSmartMoney(undefined, {
      universe: "commodities",
      source: "commodity-smartmoney",
    });
    const records = await recordCommodityCandidates(scan.candidates);
    if (commodityNotifier && records.recordedCandidates.length) {
      for (const candidate of records.recordedCandidates) {
        const message = [
          "🪙 НОВЫЙ СИГНАЛ · СЫРЬЁ И МЕТАЛЛЫ",
          "",
          smartMoneyCandidateText(candidate, 1),
        ].join("\n");
        for (const chatId of commodityChatIds) {
          await commodityNotifier(chatId, message);
        }
      }
    }
    await runCommodityPositionMonitor();
    logger.info(
      {
        analyzed: scan.analyzed,
        candidates: scan.candidates.length,
        recorded: records.recorded,
        duplicates: records.duplicates,
      },
      "Commodity Smart Money scan cycle completed",
    );
  } catch (error) {
    logger.warn({ err: error }, "Commodity Smart Money scan cycle skipped");
  } finally {
    commodityScanRunning = false;
  }
}

function waveHorizonMinutes(timeframe: string) {
  return timeframe === "30m" ? 720 : 1440;
}

function waveCandidateText(
  candidate: ElliottCandidate,
  index: number,
  signalId: number | null,
) {
  const isLong = candidate.direction === "BUY";
  const fib = candidate.fibonacci;
  const historical = candidate.historical;
  const statsLine = historical.testWinRate === null
    ? "Историческая статистика: недостаточно данных"
    : `Исторический win rate: ${formatNumber(historical.winRate, 1)}% · test: ${formatNumber(historical.testWinRate, 1)}%`;
  const targetSign = isLong ? "+" : "-";
  const stopSign = isLong ? "-" : "+";
  return [
    `${index}. ${candidate.ticker} — ${isLong ? "LONG" : "SHORT"} · ${candidate.timeframe}`,
    `Сценарий: ${candidate.scenario}`,
    `Уверенность структуры: ${formatNumber(candidate.confidence, 0)}%`,
    `Вход: ${formatNumber(candidate.entryPrice)}`,
    `Take profit: ${formatNumber(candidate.targetPrice)} (${targetSign}${formatNumber(candidate.targetPercent, 2)}%)`,
    `Stop loss: ${formatNumber(candidate.stopPrice)} (${stopSign}${formatNumber(candidate.stopPercent, 2)}%)`,
    `Инвалидация сценария: ${formatNumber(candidate.invalidationPrice)}`,
    `Минимальный целевой потенциал 0,5%: выполнен`,
    statsLine,
    `Случаев: ${historical.occurrences} · test-наблюдений: ${historical.testOccurrences}`,
    `Profit factor: ${formatNumber(historical.profitFactor)} · expectancy: ${formatNumber(historical.expectancy, 3)}%`,
    `Test expectancy: ${formatNumber(historical.testExpectancy, 3)}% · max drawdown: ${formatNumber(historical.maxDrawdown, 2)}%`,
    `Доверительный интервал win rate: ${formatNumber(historical.confidenceLow, 1)}–${formatNumber(historical.confidenceHigh, 1)}%`,
    fib
      ? `Fibonacci: ${fib.retracementZone} · retracement ${fib.retracement === null ? "—" : `${formatNumber(fib.retracement * 100, 1)}%`} · extension ${fib.extension === null ? "—" : formatNumber(fib.extension, 2)}x`
      : "Fibonacci: нет подтверждённой пары anchors",
    candidate.relativeVolume === null
      ? "Относительный объём: —"
      : `Относительный объём: ${formatNumber(candidate.relativeVolume, 2)}x`,
    "Подтверждения:",
    ...candidate.reasons.map((reason) => `• ${reason}`),
    `Paper-горизонт: ${waveHorizonMinutes(candidate.timeframe)} минут`,
    signalId
      ? `ID сигнала: ${signalId} · отметьте результат кнопкой или /wave_result ${signalId} 1.25`
      : "Сигнал не записан",
    "Режим: PAPER TRADING — реальные сделки не совершаются",
  ].join("\n");
}

async function recordWaveCandidates(candidates: ElliottCandidate[]) {
  const records: {
    candidate: ElliottCandidate;
    status: PaperRecordResult;
    signalId: number | null;
  }[] = [];
  for (const candidate of candidates) {
    const result = await recordPaperSignal({
      ticker: candidate.ticker,
      featureTimestamp: candidate.timestamp,
      direction: candidate.direction,
      confidence: candidate.confidence,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
      targetPrice: candidate.targetPrice,
      horizonMinutes: waveHorizonMinutes(candidate.timeframe),
      reasons: candidate.reasons,
      patternIds: [],
      combinationIds: [],
      source: "wave",
      timeframe: candidate.timeframe,
      bypassRiskLimits: true,
      metadata: {
        timeframe: candidate.timeframe,
        strategyFamily: "elliott_fibonacci",
        setupType: candidate.setupType,
        scenario: candidate.scenario,
        invalidationPrice: candidate.invalidationPrice,
        targetPercent: candidate.targetPercent,
        stopPercent: candidate.stopPercent,
        historical: candidate.historical,
        fibonacci: candidate.fibonacci,
        relativeVolume: candidate.relativeVolume,
        manualReview: true,
      },
    });
    const signal = await db
      .select({ id: signalsHistory.id })
      .from(signalsHistory)
      .where(
        and(
          eq(signalsHistory.ticker, candidate.ticker),
          eq(signalsHistory.timeframe, candidate.timeframe),
          eq(signalsHistory.candleTimestamp, candidate.timestamp),
          eq(signalsHistory.direction, candidate.direction),
          sql`COALESCE(${signalsHistory.metadata}->>'source', '') = 'wave'`,
        ),
      )
      .orderBy(desc(signalsHistory.id))
      .limit(1);
    records.push({
      candidate,
      status: result,
      signalId: signal[0]?.id ?? null,
    });
  }
  return records;
}

async function refreshWaveData() {
  if (latestWaveRefresh) return latestWaveRefresh;
  latestWaveRefresh = (async () => {
    if (latestIntradayRefresh) await latestIntradayRefresh;
    if (latestMarketRefresh) await latestMarketRefresh;
    const counts = await db.execute(sql`
      SELECT timeframe, COUNT(*)::int AS count
      FROM candles
      WHERE timeframe IN ('30m', '1h')
      GROUP BY timeframe
    `);
    const countByTimeframe = new Map(
      counts.rows.map((row) => [
        String((row as { timeframe: string }).timeframe),
        Number((row as { count: number }).count) || 0,
      ]),
    );
    for (const timeframe of ["30m", "1h"] as const) {
      const days = (countByTimeframe.get(timeframe) ?? 0) >= 5000 ? 5 : 730;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "pnpm",
          [
            "--filter",
            "@workspace/scripts",
            "run",
            "download-moex",
            "--",
            "--latest-only=true",
            `--timeframe=${timeframe}`,
            `--days=${days}`,
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout.on("data", (chunk: Buffer) => {
          logger.info(
            { output: chunk.toString().trim(), timeframe },
            "Wave timeframe refresh output",
          );
        });
        child.stderr.on("data", (chunk: Buffer) => {
          logger.warn(
            { output: chunk.toString().trim(), timeframe },
            "Wave timeframe refresh error output",
          );
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else {
            reject(
              new Error(
                `Обновление ${timeframe} завершилось с кодом ${code ?? "нет"}${signal ? ` (${signal})` : ""}`,
              ),
            );
          }
        });
      });
    }
  })().finally(() => {
    latestWaveRefresh = null;
  });
  return latestWaveRefresh;
}

async function wavesText(): Promise<TelegramMessage> {
  try {
    await refreshWaveData();
    const scan = await scanElliottWaveStrategies();
    const records = await recordWaveCandidates(scan.candidates);
    const blocks = records
      .map(({ candidate, signalId }, index) => waveCandidateText(candidate, index + 1, signalId))
      .flatMap((block) => [block, ""]);
    const buttons = records
      .filter(({ signalId }) => signalId !== null)
      .flatMap(({ signalId }) => [
        [
          {
            text: `✅ Сработал #${signalId}`,
            callback_data: `wave:win:${signalId}`,
          },
          {
            text: `❌ Не сработал #${signalId}`,
            callback_data: `wave:loss:${signalId}`,
          },
        ],
      ]);
    const recorded = records.filter(({ status }) => status === "recorded").length;
    const duplicates = records.filter(({ status }) => status === "duplicate").length;
    const blocked = records.filter(({ status }) => status === "risk_limit").length;
    const text = [
      "🌊 ВОЛНОВОЙ АНАЛИЗ · ELLIOTT + ABC + FIBONACCI",
      "",
      `Проверено серий: ${scan.series} · свежих: ${scan.freshSeries}`,
      `Найдено текущих сигналов: ${scan.totalCandidates} · показаны топ-${scan.candidates.length}`,
      `Таймфреймы: 30m и 1h · обновлено: ${formatDate(scan.generatedAt)}`,
      "Пивоты подтверждаются будущими свечами и не используются до момента подтверждения.",
      `Записано новых: ${recorded} · повторов: ${duplicates} · ошибок записи: ${blocked}`,
      "",
      blocks.length
        ? blocks
        : ["Свежих волновых триггеров сейчас нет.", ""],
      scan.unavailable.length
        ? `Не готовы к оценке: ${scan.unavailable.slice(0, 5).join("; ")}${scan.unavailable.length > 5 ? " и другие" : ""}`
        : "Все доступные серии имеют достаточную историю.",
      "",
      "Показаны до 5 лучших текущих структурных сигналов по уверенности. Историческая статистика приведена справочно и не блокирует выдачу.",
      "Уровни поддержки/сопротивления в этот раздел не входят — они будут отдельным анализом.",
      "После проверки нажмите кнопку результата. Точный процент: /wave_result ID процент.",
      "Важно: это исследовательский paper-сигнал, не финансовая рекомендация.",
    ].join("\n");
    return {
      text,
      replyMarkup: buttons.length ? { inline_keyboard: buttons } : TELEGRAM_MENU,
    };
  } catch (error) {
    logger.error({ err: error }, "Elliott wave scan failed");
    return {
      text: [
      "🌊 ВОЛНОВОЙ АНАЛИЗ · ELLIOTT + FIBONACCI",
      "",
      "Не удалось обновить старшие свечи или завершить расчёт.",
      "Сигналы не формирую, чтобы не использовать неполные или устаревшие данные.",
      ].join("\n"),
      replyMarkup: TELEGRAM_MENU,
    };
  }
}

async function runWaveScanCycle() {
  if (waveScanRunning) return;
  waveScanRunning = true;
  try {
    await refreshWaveData();
    const scan = await scanElliottWaveStrategies();
    const records = await recordWaveCandidates(scan.candidates);
    logger.info(
      {
        series: scan.series,
        freshSeries: scan.freshSeries,
        candidates: scan.candidates.length,
        recorded: records.filter(({ status }) => status === "recorded").length,
        duplicates: records.filter(({ status }) => status === "duplicate").length,
        blocked: records.filter(({ status }) => status === "risk_limit").length,
      },
      "Elliott wave scan cycle completed",
    );
  } catch (error) {
    logger.warn({ err: error }, "Elliott wave scan cycle skipped");
  } finally {
    waveScanRunning = false;
  }
}

async function intradayText() {
  try {
    await refreshLatestIntradayData();
    const scan = await scanIntraday();
    const paperStatuses = await recordIntradayCandidates(scan.candidates);
    const blocks = scan.candidates
      .map((candidate, index) => intradayCandidateText(candidate, index + 1))
      .filter((block): block is string => Boolean(block));
    const unavailablePreview = scan.unavailable.slice(0, 3);
    return [
      "⚡ ВНУТРИДНЕВНОЙ СКАНЕР IMOEX",
      "",
      `Проверено бумаг: ${scan.analyzed}`,
      `Свежие индикаторы: ${scan.freshFeatures}`,
      `Обновлено: ${formatDate(scan.generatedAt)}`,
      "Фильтры: спред до 0,35% · оборот от 5 млн ₽ · данные не старше 30 минут",
      `Paper-сигналов принято: ${paperStatuses.recorded} · повторов: ${paperStatuses.duplicates} · заблокировано лимитом: ${paperStatuses.blocked}`,
      "",
      blocks.length ? blocks.flatMap((block) => [block, ""]) : ["Подходящих свежих сетапов сейчас нет.", ""],
      unavailablePreview.length
        ? `Не готовы к оценке: ${unavailablePreview.join("; ")}${scan.unavailable.length > unavailablePreview.length ? " и другие" : ""}`
        : "Все активные бумаги прошли проверку свежести.",
      "",
      "Стакан и поток сделок пока не подтверждают сигнал: MOEX не отдал orderbook через публичный endpoint.",
      "Используются 1m-свечи MOEX, Opening Range, VWAP, EMA, RSI, ADX и бумажная проверка исполнения.",
      "",
      "Важно: это исследовательский paper-сигнал, не финансовая рекомендация.",
    ].join("\n");
  } catch (error) {
    logger.error({ err: error }, "Intraday scan failed");
    return [
      "⚡ ВНУТРИДНЕВНОЙ СКАНЕР IMOEX",
      "",
      "Не удалось получить актуальные котировки MOEX.",
      "Сигналы не формирую, чтобы не использовать старые данные.",
    ].join("\n");
  }
}

async function recordSmartMoneyCandidates(candidates: SmartMoneyCandidate[]) {
  let recorded = 0;
  let duplicates = 0;
  let blocked = 0;
  for (const candidate of candidates) {
    const result = await recordPaperSignal({
      ticker: candidate.ticker,
      featureTimestamp: candidate.timestamp,
      direction: candidate.direction,
      confidence: candidate.score,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
      targetPrice: candidate.takeProfit2,
      horizonMinutes: 360,
      reasons: candidate.reasons,
      patternIds: [],
      combinationIds: [],
      source: "smartmoney",
      timeframe: "15m",
      metadata: {
        smartMoney: true,
        timeframe: "15m",
        setupTimeframe: "15m",
        executionTimeframe: "1m",
        strategy: "SMC-Accumulation-BOS-CHoCH",
        probability: candidate.probability,
        adaptiveThreshold: candidate.threshold,
        rewardRisk: candidate.rewardRisk,
        netRewardRisk: candidate.netRewardRisk,
        takeProfit1: candidate.takeProfit1,
        takeProfit2: candidate.takeProfit2,
        takeProfit3: candidate.takeProfit3,
        accumulation: candidate.accumulation,
        structure: candidate.structure,
        liquidity: candidate.liquidity,
        orderBlock: candidate.orderBlock,
        fairValueGap: candidate.fairValueGap,
        volumeConfirmed: candidate.volumeConfirmed,
        retestConfirmed: candidate.retestConfirmed,
        higherTimeframeAgreement: candidate.higherTimeframeAgreement,
        marketRegime: candidate.marketRegime,
        bosQuality: candidate.bosQuality,
        impulseConfirmed: candidate.impulseConfirmed,
        rangeToAtr: candidate.rangeToAtr,
        chart: candidate.chart,
      },
    });
    if (result === "recorded") recorded += 1;
    else if (result === "duplicate") duplicates += 1;
    else blocked += 1;
  }
  return { recorded, duplicates, blocked };
}

async function smartMoneyText() {
  try {
    await ensureSmartMoneyDataFresh();
    await ensureSmartMoneyHigherTimeframes(false);
    const scan = await scanSmartMoney();
    const records = await recordSmartMoneyCandidates(scan.candidates);
    const blocks = scan.candidates.map((candidate, index) =>
      smartMoneyCandidateText(candidate, index + 1),
    );
    const rejectionPreview = Object.entries(scan.filterStats)
      .filter(([, count]) => count > 0)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 3)
      .map(([name, count]) => `${name}: ${count}`)
      .join(" · ");
    return [
      "💰 SMART MONEY · SMC IMOEX",
      "",
      `Проверено акций: ${scan.analyzed} · обновлено: ${formatDate(scan.generatedAt)}`,
      `Адаптивный минимальный рейтинг: ${formatNumber(scan.threshold, 0)}/100`,
      "Фильтр: накопление + BOS + CHoCH + объём + HTF alignment + R:R ≥ 1:2.",
      `Новых paper-сигналов: ${records.recorded} · повторов: ${records.duplicates} · заблокировано риск-фильтром: ${records.blocked}`,
      scan.cooldownSkipped
        ? `Cooldown: ${scan.cooldownSkipped} тикеров временно пропущено после недавнего SMC-сигнала.`
        : "Cooldown: повторных SMC-сигналов по тикерам нет.",
      rejectionPreview
        ? `Основные причины отсева: ${rejectionPreview}`
        : "Основных причин отсева нет.",
      "",
      ...(blocks.length
        ? blocks.flatMap((block) => [block, ""])
        : [
            "Свежих Smart Money-сетапов нет.",
            "",
            "Сигнал не создаётся, если отсутствует подтверждённое накопление, BOS/CHoCH, объём, согласование старших таймфреймов или R:R ниже 1:2.",
          ]),
      scan.unavailable.length
        ? `Недоступны для оценки: ${scan.unavailable.slice(0, 5).join("; ")}${scan.unavailable.length > 5 ? " и другие" : ""}`
        : "Все тикеры имеют достаточную историю для проверки.",
      "",
      "Режим: PAPER TRADING — реальные деньги не используются.",
      "Smart Money — исследовательская стратегия, не финансовая рекомендация.",
    ].join("\n");
  } catch (error) {
    logger.error({ err: error }, "Smart Money scan failed");
    return [
      "💰 SMART MONEY · SMC IMOEX",
      "",
      "Не удалось завершить Smart Money-сканирование.",
      "Сигналы не формирую, чтобы не использовать неполные данные.",
    ].join("\n");
  }
}

function ensureSmartMoneyHigherTimeframes(waitForWaveRefresh = true) {
  if (latestSmartMoneyHigherRefresh) return latestSmartMoneyHigherRefresh;
  latestSmartMoneyHigherRefresh = (async () => {
    if (waitForWaveRefresh && latestWaveRefresh) await latestWaveRefresh;
    const latest = await db.execute(sql`
      SELECT MIN(latest) AS latest
      FROM (
        SELECT ticker, MAX(timestamp) AS latest
        FROM candles
        WHERE timeframe = '1h'
          AND (
            ticker IN (SELECT secid FROM moex_tickers WHERE is_active = true)
            OR ticker IN ('SMLT', 'SOFL', 'DELI')
          )
        GROUP BY ticker
      ) latest_by_ticker
    `);
    const rawLatest = (latest.rows[0] as { latest?: unknown } | undefined)?.latest;
    const latestTimestamp =
      rawLatest instanceof Date ? rawLatest : rawLatest ? new Date(String(rawLatest)) : null;
    const isFresh =
      latestTimestamp !== null &&
      Number.isFinite(latestTimestamp.getTime()) &&
      Date.now() - latestTimestamp.getTime() <= SMART_MONEY_1H_MAX_AGE_MS;
    if (isFresh) return;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "--filter",
          "@workspace/scripts",
          "run",
          "download-moex",
          "--",
          "--latest-only=true",
          "--timeframe=1h",
          "--days=5",
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        logger.info({ output: chunk.toString().trim() }, "Smart Money 1h refresh output");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logger.warn({ output: chunk.toString().trim() }, "Smart Money 1h refresh error output");
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Smart Money 1h refresh exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
            ),
          );
        }
      });
    });
  })().finally(() => {
    latestSmartMoneyHigherRefresh = null;
  });
  return latestSmartMoneyHigherRefresh;
}

async function ensureSmartMoneyDataFresh() {
  const latest = await db.execute(sql`
    SELECT timeframe, MIN(latest) AS latest
    FROM (
      SELECT ticker, timeframe, MAX(timestamp) AS latest
      FROM candles
        WHERE timeframe IN ('1m', '1h')
          AND (
            ticker IN (SELECT secid FROM moex_tickers WHERE is_active = true)
            OR ticker IN ('SMLT', 'SOFL', 'DELI')
          )
      GROUP BY ticker, timeframe
    ) latest_by_ticker
    GROUP BY timeframe
  `);
  const freshness = new Map(
    latest.rows.map((row) => {
      const value = row as { timeframe?: unknown; latest?: unknown };
      const timestamp =
        value.latest instanceof Date
          ? value.latest
          : value.latest
            ? new Date(String(value.latest))
            : null;
      return [String(value.timeframe), timestamp] as const;
    }),
  );
  const oneMinuteLatest = freshness.get("1m");
  const oneHourLatest = freshness.get("1h");
  const oneMinuteFresh =
    oneMinuteLatest !== null &&
    oneMinuteLatest !== undefined &&
    Number.isFinite(oneMinuteLatest.getTime()) &&
    Date.now() - oneMinuteLatest.getTime() <= SMART_MONEY_1M_MAX_AGE_MS;
  const oneHourFresh =
    oneHourLatest !== null &&
    oneHourLatest !== undefined &&
    Number.isFinite(oneHourLatest.getTime()) &&
    Date.now() - oneHourLatest.getTime() <= SMART_MONEY_1H_MAX_AGE_MS;
  if (oneMinuteFresh && oneHourFresh) return;
  await refreshLatestIntradayData();
}

async function runSmartMoneyScanCycle() {
  if (smartMoneyScanRunning) return;
  smartMoneyScanRunning = true;
  try {
    await refreshLatestIntradayData();
    await ensureSmartMoneyHigherTimeframes();
    const scan = await scanSmartMoney();
    const records = await recordSmartMoneyCandidates(scan.candidates);
    logger.info(
      {
        analyzed: scan.analyzed,
        candidates: scan.candidates.length,
        recorded: records.recorded,
        duplicates: records.duplicates,
        blocked: records.blocked,
      },
      "Smart Money scan cycle completed",
    );
  } catch (error) {
    logger.warn({ err: error }, "Smart Money scan cycle skipped");
  } finally {
    smartMoneyScanRunning = false;
  }
}

async function recordIntradayCandidates(candidates: IntradayCandidate[]) {
  let recorded = 0;
  let duplicates = 0;
  let blocked = 0;
  for (const candidate of candidates) {
    const isLong = candidate.direction === "BUY";
    const entry = isLong ? candidate.quote.offer : candidate.quote.bid;
    if (entry === null || !Number.isFinite(entry)) {
      blocked += 1;
      continue;
    }
    const target = isLong
      ? entry * (1 + candidate.targetPercent / 100)
      : entry * (1 - candidate.targetPercent / 100);
    const stop = isLong
      ? entry * (1 - candidate.stopPercent / 100)
      : entry * (1 + candidate.stopPercent / 100);
    const result = await recordPaperSignal({
      ticker: candidate.ticker,
      featureTimestamp: candidate.feature.timestamp,
      direction: candidate.direction,
      confidence: candidate.score,
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: target,
      horizonMinutes: INTRADAY_HORIZON_MINUTES,
      reasons: candidate.reasons,
      patternIds: [],
      combinationIds: [],
      source: "intraday",
      metadata: {
        intraday: true,
        timeframe: "1m",
        quoteLast: candidate.quote.last,
        bid: candidate.quote.bid,
        offer: candidate.quote.offer,
        spreadPercent: candidate.spreadPercent,
        currentChangePercent: candidate.currentChangePercent,
        distanceToVwapPercent: candidate.distanceToVwapPercent,
        orderBookStatus: "not_available",
        signalValidityMinutes: 3,
      },
    });
    if (result === "recorded") recorded += 1;
    else if (result === "duplicate") duplicates += 1;
    else blocked += 1;
  }
  return { recorded, duplicates, blocked };
}

async function runIntradayScanCycle() {
  if (intradayScanRunning) return;
  intradayScanRunning = true;
  try {
    await refreshLatestIntradayData();
    const scan = await scanIntraday();
    const paperStatuses = await recordIntradayCandidates(scan.candidates);
    logger.info(
      {
        analyzed: scan.analyzed,
        freshFeatures: scan.freshFeatures,
        candidates: scan.candidates.length,
        recorded: paperStatuses.recorded,
        duplicates: paperStatuses.duplicates,
        blocked: paperStatuses.blocked,
      },
      "Intraday scan cycle completed",
    );
  } catch (error) {
    logger.warn({ err: error }, "Intraday scan cycle skipped");
  } finally {
    intradayScanRunning = false;
  }
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

function isAnalogRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === ANALOG_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "аналогичные рыночные ситуации" ||
    normalizedText === "/analogs"
  );
}

function isAccuracyRequest(text: string) {
  const normalizedText = text.trim().toLocaleLowerCase("ru-RU");
  return (
    normalizedText === ACCURACY_BUTTON.toLocaleLowerCase("ru-RU") ||
    normalizedText === "точность сигналов" ||
    normalizedText === "/accuracy"
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
    text: "🎯 Выберите акцию IMOEX для Smart Money:",
    replyMarkup: {
      inline_keyboard: Array.from(
        { length: Math.ceil(buttons.length / 2) },
        (_, index) => buttons.slice(index * 2, index * 2 + 2),
      ),
    },
  };
}

async function companyAnalysisPicker() {
  const rows = await db
    .select({
      ticker: moexTickers.secid,
      shortName: moexTickers.shortName,
    })
    .from(moexTickers)
    .where(eq(moexTickers.isActive, true))
    .orderBy(asc(moexTickers.rank));
  const known = new Map(rows.map((row) => [row.ticker, row]));
  if (!known.has("WUSH")) {
    rows.push({ ticker: "WUSH", shortName: "ВУШ Холдинг" });
  }
  const buttons = rows.map((row) => ({
    text: row.shortName
      ? `${row.ticker} — ${row.shortName.slice(0, 18)}`
      : row.ticker,
    callback_data: `analysis:${row.ticker}`,
  }));
  return {
    text: [
      "🔎 Выберите компанию для Smart Money-проверки.",
      "",
      "Можно также отправить команду /analysis ТИКЕР или название компании.",
      "Например: /analysis WUSH или /analysis ВУШ",
    ].join("\n"),
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

function refreshLatestMarketData() {
  if (latestMarketRefresh) return latestMarketRefresh;
  latestMarketRefresh = new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@workspace/scripts",
        "run",
        "download-moex",
        "--",
        "--latest-only=true",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      logger.info({ output: chunk.toString().trim() }, "Latest MOEX refresh output");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logger.warn({ output: chunk.toString().trim() }, "Latest MOEX refresh error output");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Актуальное обновление MOEX завершилось с кодом ${code ?? "нет"}${signal ? ` (${signal})` : ""}`,
          ),
        );
      }
    });
  }).finally(() => {
    latestMarketRefresh = null;
  });
  return latestMarketRefresh;
}

function refreshLatestIntradayData() {
  if (latestIntradayRefresh) return latestIntradayRefresh;
  latestIntradayRefresh = new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@workspace/scripts",
        "run",
        "download-moex",
        "--",
        "--latest-only=true",
        "--timeframe=1m",
        "--days=2",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      logger.info({ output: chunk.toString().trim() }, "Latest intraday MOEX refresh output");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logger.warn({ output: chunk.toString().trim() }, "Latest intraday MOEX refresh error output");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Актуальное обновление 1m MOEX завершилось с кодом ${code ?? "нет"}${signal ? ` (${signal})` : ""}`,
          ),
        );
      }
    });
  }).finally(() => {
    latestIntradayRefresh = null;
  });
  return latestIntradayRefresh;
}

function refreshCompanyAnalysisData(ticker: string) {
  const existing = companyAnalysisRefreshes.get(ticker);
  if (existing) return existing;

  const runImport = (timeframe: string, days: number) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "--filter",
          "@workspace/scripts",
          "run",
          "download-moex",
          "--",
          "--latest-only=true",
          `--timeframe=${timeframe}`,
          `--days=${days}`,
          `--ticker=${ticker}`,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        logger.info(
          { ticker, timeframe, output: chunk.toString().trim() },
          "Company analysis MOEX refresh output",
        );
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logger.warn(
          { ticker, timeframe, output: chunk.toString().trim() },
          "Company analysis MOEX refresh error output",
        );
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${timeframe} refresh failed for ${ticker}: code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
            ),
          );
        }
      });
    });

  const refresh = (async () => {
    await runImport("1m", 2);
    await runImport("1h", 60);
  })().finally(() => {
    companyAnalysisRefreshes.delete(ticker);
  });
  companyAnalysisRefreshes.set(ticker, refresh);
  return refresh;
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
  try {
    await refreshLatestMarketData();
  } catch (error) {
    logger.error({ err: error, ticker }, "Latest MOEX refresh failed before ticker signal");
    return [
      `📊 ${ticker}`,
      "",
      "Не удалось получить свежую свечу MOEX.",
      "Старые данные не использую, чтобы не отправлять устаревший вход.",
    ].join("\n");
  }
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
  if (dataAgeMinutes(feature.timestamp) > SIGNAL_MAX_AGE_MINUTES) {
    return [
      `📊 ${ticker}`,
      "",
      "⚠️ Данные устарели. Сигнал не формирую.",
      dataFreshnessText(feature.timestamp),
      `Допустимый возраст данных: до ${SIGNAL_MAX_AGE_MINUTES} минут.`,
    ].join("\n");
  }

  const analysis = await analyzeSignal(ticker, feature);
  const latestMarket = await getLatestMarket();
  const combinationIds = analysis.matched.map((combination) => combination.id);
  const patternIds = analysis.matchedPatterns.map((pattern) => pattern.id);
  const bestCombination =
    analysis.matched
      .filter((combination) => combination.direction === analysis.direction)
      .sort((left, right) => (right.expectedValue ?? -Infinity) - (left.expectedValue ?? -Infinity))[0] ??
    analysis.matched[0];
  const recorded = await recordPaperSignal({
    ticker,
    featureTimestamp: feature.timestamp,
    direction: analysis.direction,
    confidence: analysis.confidence,
    entryPrice: feature.close,
    stopPrice: analysis.stop,
    targetPrice: analysis.target,
    horizonMinutes: PAPER_HORIZON_MINUTES,
    reasons: analysis.reasons,
    patternIds,
    combinationIds,
    source: "telegram",
    metadata: {
      validatedCombinations: combinationIds,
      validatedPatterns: patternIds,
      marketStructure: analysis.marketStructure,
      marketRegime: marketRegime(latestMarket?.imoexChange),
    },
  });
  const riskDistance = Math.abs(feature.close - analysis.stop);
  const rewardDistance = Math.abs(analysis.target - feature.close);
  const rewardRisk =
    riskDistance > 0 && Number.isFinite(riskDistance) && Number.isFinite(rewardDistance)
      ? rewardDistance / riskDistance
      : null;
  const validUntil = new Date(
    feature.timestamp.getTime() + PAPER_HORIZON_MINUTES * 60_000,
  );

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
    `Действует до: ${formatDate(validUntil)}`,
    `Потенциал / риск: ${formatNumber(rewardRisk, 2)} к 1`,
    dataFreshnessText(feature.timestamp),
    "Режим: PAPER TRADING — сделка только отслеживается, реальные деньги не используются",
    paperRecordText(recorded),
    "",
    "Важно: это статистический исследовательский сигнал, не финансовая рекомендация.",
  ].join("\n");
}

type CompanyCandle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type CompanyTimeframeAnalysis = {
  label: string;
  rows: CompanyCandle[];
  direction: SignalDirection;
  changePercent: number | null;
  change20Percent: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi: number | null;
  atrPercent: number | null;
  volumeRatio: number | null;
  support: number | null;
  resistance: number | null;
  structure: string;
};

function averageNumbers(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function emaValue(values: number[], period: number) {
  if (values.length < period) return null;
  let current = averageNumbers(values.slice(0, period));
  if (current === null) return null;
  const multiplier = 2 / (period + 1);
  for (const value of values.slice(period)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

function rsiValue(values: number[], period = 14) {
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

function atrValue(rows: CompanyCandle[], period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.slice(1).map((row, index) => {
    const previous = rows[index];
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previous.close),
      Math.abs(row.low - previous.close),
    );
  });
  return averageNumbers(ranges.slice(-period));
}

function percentChange(from: number | undefined, to: number | undefined) {
  if (from === undefined || to === undefined || from === 0) return null;
  return ((to - from) / from) * 100;
}

function currentWeekStart() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  return start.getTime();
}

function aggregateCalendarBars(rows: CompanyCandle[], unit: "week" | "month") {
  const groups = new Map<number, CompanyCandle[]>();
  for (const row of rows) {
    const date = new Date(row.timestamp);
    const bucket =
      unit === "month"
        ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
        : (() => {
            const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
            const mondayOffset = (date.getUTCDay() + 6) % 7;
            return start - mondayOffset * 24 * 60 * 60 * 1000;
          })();
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, group]) => ({
      timestamp: new Date(bucket),
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, row) => sum + row.volume, 0),
    }));
}

function companyTimeframeAnalysis(
  label: string,
  rows: CompanyCandle[],
): CompanyTimeframeAnalysis {
  const closes = rows.map((row) => row.close);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const ema20 = emaValue(closes, 20);
  const ema50 = emaValue(closes, 50);
  const atr = atrValue(rows);
  const recent = rows.slice(-20);
  const recentAverage = averageNumbers(recent.map((row) => row.close));
  const olderAverage = averageNumbers(rows.slice(-40, -20).map((row) => row.close));
  const direction =
    latest && ema20 !== null && ema50 !== null
      ? latest.close > ema20 && ema20 > ema50
        ? "BUY"
        : latest.close < ema20 && ema20 < ema50
          ? "SELL"
          : "HOLD"
      : latest && recentAverage !== null && olderAverage !== null
        ? recentAverage > olderAverage
          ? "BUY"
          : recentAverage < olderAverage
            ? "SELL"
            : "HOLD"
        : "HOLD";
  const recentHigh = recent.length ? Math.max(...recent.map((row) => row.high)) : null;
  const recentLow = recent.length ? Math.min(...recent.map((row) => row.low)) : null;
  const previousBlock = rows.slice(-40, -20);
  const structure =
    recent.length >= 10 && previousBlock.length >= 10
      ? recentHigh !== null &&
        previousBlock.length &&
        recentHigh > Math.max(...previousBlock.map((row) => row.high)) &&
        recentLow !== null &&
        recentLow > Math.min(...previousBlock.map((row) => row.low))
        ? "повышающиеся максимумы и минимумы"
        : recentHigh !== null &&
            recentLow !== null &&
            recentHigh < Math.max(...previousBlock.map((row) => row.high)) &&
            recentLow < Math.min(...previousBlock.map((row) => row.low))
          ? "понижающиеся максимумы и минимумы"
          : "боковая/смешанная структура"
      : "недостаточно подтверждённых баров";
  const averageVolume = averageNumbers(rows.slice(-21, -1).map((row) => row.volume));
  return {
    label,
    rows,
    direction,
    changePercent: percentChange(previous?.close, latest?.close),
    change20Percent: percentChange(rows.at(-21)?.close, latest?.close),
    ema20,
    ema50,
    rsi: rsiValue(closes),
    atrPercent: latest && atr !== null ? (atr / latest.close) * 100 : null,
    volumeRatio:
      latest && averageVolume !== null && averageVolume > 0
        ? latest.volume / averageVolume
        : null,
    support: recentLow,
    resistance: recentHigh,
    structure,
  };
}

async function resolveCompanyTicker(input: string) {
  const normalized = input.trim().toUpperCase();
  const aliases: Record<string, { ticker: string; shortName: string }> = {
    WHOOSH: { ticker: "WUSH", shortName: "ВУШ Холдинг" },
    ВУШ: { ticker: "WUSH", shortName: "ВУШ Холдинг" },
    ВУШХОЛДИНГ: { ticker: "WUSH", shortName: "ВУШ Холдинг" },
  };
  if (aliases[normalized]) return aliases[normalized];
  const result = await db.execute(sql`
    SELECT secid, short_name
    FROM moex_tickers
    WHERE UPPER(secid) = ${normalized}
       OR lower(coalesce(short_name, '')) LIKE lower(${"%" + input.trim() + "%"})
    ORDER BY is_active DESC, rank NULLS LAST
    LIMIT 1
  `);
  const row = result.rows[0] as { secid?: unknown; short_name?: unknown } | undefined;
  return row?.secid
    ? { ticker: String(row.secid), shortName: row.short_name ? String(row.short_name) : null }
    : null;
}

async function getCompanyCandles(ticker: string, timeframe: string, limit: number) {
  const result = await db.execute(sql`
    SELECT timestamp, open, high, low, close, volume
    FROM candles
    WHERE ticker = ${ticker} AND timeframe = ${timeframe}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `);
  return result.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        timestamp: new Date(String(row.timestamp)),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume) || 0,
      };
    })
    .filter((row) => Number.isFinite(row.timestamp.getTime()) && Number.isFinite(row.close))
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function closedCompanyRows(rows: CompanyCandle[], timeframe: "1h" | "1d") {
  if (timeframe === "1h") return rows.length > 1 ? rows.slice(0, -1) : [];
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter((row) => row.timestamp.toISOString().slice(0, 10) < today);
}

function companyTimeframeText(analysis: CompanyTimeframeAnalysis) {
  const latest = analysis.rows.at(-1);
  return [
    `${analysis.label}: ${analysis.rows.length} закрытых свечей`,
    latest ? `Последняя закрытая цена: ${formatNumber(latest.close)} · ${formatDate(latest.timestamp)}` : "Данные отсутствуют",
    `Тренд: ${directionLabel(analysis.direction)} · 1 бар: ${formatNumber(analysis.changePercent)}% · 20 баров: ${formatNumber(analysis.change20Percent)}%`,
    `EMA20: ${formatNumber(analysis.ema20)} · EMA50: ${formatNumber(analysis.ema50)} · RSI(14): ${formatNumber(analysis.rsi)}`,
    `ATR: ${formatNumber(analysis.atrPercent)}% цены · объём к среднему: ${formatNumber(analysis.volumeRatio)}x`,
    `Поддержка/сопротивление за 20 баров: ${formatNumber(analysis.support)} / ${formatNumber(analysis.resistance)}`,
    `Структура: ${analysis.structure}`,
  ].join("\n");
}

async function companyAnalysisText(input: string) {
  const resolved = await resolveCompanyTicker(input);
  if (!resolved) return "";
  const { ticker } = resolved;
  try {
    await refreshCompanyAnalysisData(ticker);
    await ensureSmartMoneyHigherTimeframes();
    const smartScan = await scanSmartMoney(ticker);
    const candidate = smartScan.candidates.find((item) => item.ticker === ticker);
    if (!candidate) {
      logger.info({ ticker }, "Company Smart Money has no entry");
      return "";
    }
    await recordSmartMoneyCandidates([candidate]);
    return smartMoneyCandidateText(candidate, 1);
  } catch (error) {
    logger.error({ err: error, ticker }, "Company analysis failed");
    return "";
  }
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
  try {
    await refreshLatestMarketData();
  } catch (error) {
    logger.error({ err: error }, "Latest MOEX refresh failed before TOP analysis");
    return [
      "🔥 Лучшие сигналы IMOEX",
      "",
      "Не удалось получить свежие свечи MOEX.",
      "Старые данные не использую, чтобы не отправлять устаревший вход.",
      "Попробуйте нажать «🔥 Лучшие сигналы» ещё раз через несколько секунд.",
    ].join("\n");
  }
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
    const evidence = item.analysis.historicalEvidence;
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

  await Promise.all(
    ranked.map(async (candidate) => {
      if (dataAgeMinutes(candidate.row.timestamp) > SIGNAL_MAX_AGE_MINUTES) return;
      const entry = candidate.row.close;
      const evidence = candidate.evidence;
      const takeProfitPercent =
        historicalPercent(evidence?.bestTakeProfit) ??
        historicalMedianPercent(
          context.combinations,
          candidate.analysis.direction,
          "bestTakeProfit",
        );
      const stopLossPercent =
        historicalPercent(evidence?.bestStopLoss) ??
        historicalMedianPercent(
          context.combinations,
          candidate.analysis.direction,
          "bestStopLoss",
        );
      const target =
        candidate.analysis.direction === "BUY"
          ? entry * (1 + takeProfitPercent / 100)
          : entry * (1 - takeProfitPercent / 100);
      const stop =
        candidate.analysis.direction === "BUY"
          ? entry * (1 - stopLossPercent / 100)
          : entry * (1 + stopLossPercent / 100);
      const regime = marketRegime(macroPressure(context.macro));
      await recordPaperSignal({
        ticker: candidate.row.ticker,
        featureTimestamp: candidate.row.timestamp,
        direction: candidate.analysis.direction,
        confidence: candidate.rating,
        entryPrice: entry,
        stopPrice: stop,
        targetPrice: target,
        horizonMinutes: PAPER_HORIZON_MINUTES,
        reasons: candidate.analysis.reasons,
        patternIds: candidate.analysis.matchedPatterns.map((pattern) => pattern.id),
        combinationIds: candidate.analysis.matched.map((combination) => combination.id),
        source: "top",
        metadata: {
          score: candidate.rating,
          paperHorizonMinutes: PAPER_HORIZON_MINUTES,
          marketRegime: regime,
        },
      });
    }),
  );

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
    const evidenceWinRate = evidence?.successRate ?? null;
    const takeProfitPercent =
      historicalPercent(evidence?.bestTakeProfit) ??
      historicalMedianPercent(context.combinations, analysis.direction, "bestTakeProfit");
    const stopLossPercent =
      historicalPercent(evidence?.bestStopLoss) ??
      historicalMedianPercent(context.combinations, analysis.direction, "bestStopLoss");
    const target =
      analysis.direction === "BUY"
        ? entry * (1 + takeProfitPercent / 100)
        : entry * (1 - takeProfitPercent / 100);
    const stop =
      analysis.direction === "BUY"
        ? entry * (1 - stopLossPercent / 100)
        : entry * (1 + stopLossPercent / 100);
    const direction = directionLabel(analysis.direction);
    const horizon = evidence?.bestHoldingMinutes ?? analysis.horizonMinutes;
    return [
      `${index + 1}. ${row.ticker} — ${direction}`,
      `Win Rate: ${formatNumber(evidenceWinRate !== null ? evidenceWinRate * 100 : null, 2)}%`,
      `Ситуаций: ${formatCount(evidence?.occurrences)}`,
      `Вход: ${formatNumber(entry)}`,
      `Тейк: ${formatNumber(target)} (${analysis.direction === "BUY" ? "+" : "-"}${formatNumber(takeProfitPercent)}%)`,
      `Стоп: ${formatNumber(stop)} (${analysis.direction === "BUY" ? "-" : "+"}${formatNumber(stopLossPercent)}%)`,
      `Горизонт: ${formatNumber(horizon, 0)} минут`,
      dataFreshnessText(row.timestamp),
      "Paper-проверка: результат через 6 часов",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  });

  return [
    "🔥 Лучшие сигналы IMOEX",
    "",
    ...blocks.flatMap((block) => [block, ""]),
    `Проанализировано акций: ${formatCount(stats.tickers)} · обновлено: ${formatDate(new Date())}`,
    "",
    "Для детального сигнала: /signal ТИКЕР",
  ].join("\n");
}

async function analogText() {
  try {
    await refreshLatestMarketData();
    return await scanMarketAnalogues();
  } catch (error) {
    logger.error({ err: error }, "Market analog scan failed");
    return [
      "📊 Аналогичные рыночные ситуации",
      "",
      "Не удалось завершить сканирование аналогов.",
      "Проверьте свежесть данных MOEX и попробуйте ещё раз.",
    ].join("\n");
  }
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
  if (isCompanyAnalysisRequest(text)) {
    return companyAnalysisPicker();
  }
  if (
    normalizedCommand === "/analysis" ||
    normalizedCommand === "/analyze" ||
    normalizedCommand === "/company"
  ) {
    const tickerOrName = trimmedText.split(/\s+/).slice(1).join(" ").trim();
    return tickerOrName
      ? companyAnalysisText(tickerOrName)
      : companyAnalysisPicker();
  }
  if (isIntradayRequest(text)) {
    return intradayText();
  }
  if (isSmartMoneyRequest(text)) {
    return smartMoneyText();
  }
  if (isCommoditiesRequest(text)) {
    return commoditiesText(chatId);
  }
  if (isMoneyTestRequest(text)) {
    return moneyTestText(chatId);
  }
  if (isWavesRequest(text)) {
    return wavesText();
  }
  if (isWaveStatsRequest(text)) {
    return waveStatsText();
  }
  if (normalizedText === "цены" || normalizedText === "котировка") {
    return marketText();
  }
  if (normalizedCommand === "/top") {
    return topText();
  }
  if (isAccuracyRequest(text)) {
    return accuracyText();
  }
  if (isAnalogRequest(text)) {
    return analogText();
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
  if (normalizedCommand === "/wave_result") {
    const parts = trimmedText.split(/\s+/);
    const signalId = Number(parts[1]);
    const outcomePercent = Number(String(parts[2] ?? "").replace(",", "."));
    return manualWaveOutcome(signalId, outcomePercent, "custom");
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
  commodityNotifier = client.sendMessage;
  moneyTestNotifier = client.sendMessage;
  const intradayScanTimer = setInterval(() => {
    void runIntradayScanCycle();
  }, INTRADAY_SCAN_INTERVAL_MS);
  const waveScanTimer = setInterval(() => {
    void runWaveScanCycle();
  }, WAVE_SCAN_INTERVAL_MS);
  const smartMoneyScanTimer = setInterval(() => {
    void runSmartMoneyScanCycle();
  }, INTRADAY_SCAN_INTERVAL_MS);
  const commodityScanTimer = setInterval(() => {
    void runCommodityScanCycle();
  }, COMMODITY_SCAN_INTERVAL_MS);
  const moneyTestScanTimer = setInterval(() => {
    void runMoneyTestScanCycle();
  }, MONEY_TEST_SCAN_INTERVAL_MS);
  const paperEvaluationTimer = setInterval(() => {
    if (paperEvaluationRunning) return;
    paperEvaluationRunning = true;
    void evaluatePaperSignals()
      .catch((error) => {
        logger.error({ err: error }, "Paper signal evaluation failed");
      })
      .finally(() => {
        paperEvaluationRunning = false;
      });
  }, PAPER_EVALUATION_INTERVAL_MS);

  const stop = () => {
    running = false;
    controller.abort();
    clearInterval(intradayScanTimer);
    clearInterval(waveScanTimer);
    clearInterval(smartMoneyScanTimer);
    clearInterval(commodityScanTimer);
    clearInterval(moneyTestScanTimer);
    clearInterval(paperEvaluationTimer);
    commodityNotifier = null;
    moneyTestNotifier = null;
  };

  void (async () => {
    try {
      const me = await client.getMe();
      await client.deleteWebhook();
      await loadCommoditySubscriptions();
      await loadMoneyTestSubscriptions();
      await client.setMyCommands(
        JSON.stringify([
          { command: "analysis", description: "Smart Money по выбранной акции" },
          { command: "signal", description: "Сигнал по тикеру" },
          { command: "imoex", description: "Состав индекса IMOEX" },
          { command: "market", description: "Состояние рынка" },
          { command: "intraday", description: "Внутридневной сканер IMOEX" },
          { command: "smartmoney", description: "Smart Money SMC-сетапы IMOEX" },
          { command: "commodities", description: "Золото, серебро и Brent · Smart Money" },
          { command: "moneytest", description: "Экспериментальный intraday Smart Money" },
          { command: "waves", description: "Волны Эллиотта и Fibonacci" },
          { command: "wave_stats", description: "Статистика волновых сигналов" },
          { command: "top", description: "Лучшие сигналы" },
          { command: "analogs", description: "Аналогичные рыночные ситуации" },
          { command: "accuracy", description: "Точность paper-сигналов" },
          { command: "refresh", description: "Обновить данные и исследование" },
          { command: "help", description: "Справка" },
        ]),
      );
      logger.info({ username: me.username ?? "unknown" }, "Telegram bot connected");
      void runIntradayScanCycle();
      void runSmartMoneyScanCycle();
      void runCommodityScanCycle();
      void runMoneyTestScanCycle();
      void runWaveScanCycle();

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
                    : callbackData.startsWith("analysis:")
                      ? "Проверяю Smart Money по акции..."
                    : callbackData.startsWith("wave:")
                      ? "Сохраняю результат волнового сигнала..."
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
                if (callbackChatId && callbackData.startsWith("analysis:")) {
                  const ticker = callbackData
                    .slice("analysis:".length)
                    .toUpperCase()
                    .replace(/[^A-Z0-9_]/g, "");
                  const response = await companyAnalysisText(ticker);
                  if (response) {
                    await client.sendMessage(callbackChatId, response);
                    logger.info({ ticker }, "Telegram company Smart Money signal sent");
                  } else {
                    logger.info({ ticker }, "Telegram company Smart Money has no entry");
                  }
                }
                if (callbackChatId && callbackData.startsWith("wave:")) {
                  const [, result, rawId] = callbackData.split(":");
                  const signalId = Number(rawId);
                  const response =
                    result === "win"
                      ? await quickWaveOutcome(signalId, true)
                      : await quickWaveOutcome(signalId, false);
                  await client.sendMessage(callbackChatId, response);
                  logger.info({ signalId, result }, "Telegram wave result saved");
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
                if (typeof response === "string") {
                  await client.sendMessage(message.chat.id, response);
                } else {
                  await client.sendMessage(
                    message.chat.id,
                    response.text,
                    response.replyMarkup,
                  );
                }
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