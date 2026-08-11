import {
  boolean,
  bigint,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

const marketTimestamp = timestamp("timestamp", {
  withTimezone: true,
  mode: "date",
});

export const moexTickers = pgTable(
  "moex_tickers",
  {
    id: serial("id").primaryKey(),
    secid: varchar("secid", { length: 32 }).notNull(),
    shortName: text("short_name"),
    boardId: varchar("board_id", { length: 16 }).notNull().default("TQBR"),
    rank: integer("rank"),
    capitalization: doublePrecision("capitalization"),
    isActive: boolean("is_active").notNull().default(true),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("moex_tickers_secid_uq").on(table.secid),
    index("moex_tickers_active_rank_idx").on(table.isActive, table.rank),
  ],
);

export const candles = pgTable(
  "candles",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull().default("10m"),
    timestamp: marketTimestamp.notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume").notNull().default(0),
    value: doublePrecision("value"),
    source: varchar("source", { length: 32 }).notNull().default("moex_iss"),
  },
  (table) => [
    uniqueIndex("candles_ticker_timeframe_timestamp_source_uq").on(
      table.ticker,
      table.timeframe,
      table.timestamp,
      table.source,
    ),
    index("candles_ticker_timestamp_idx").on(table.ticker, table.timestamp),
  ],
);

export const marketContext = pgTable(
  "market_context",
  {
    id: serial("id").primaryKey(),
    timestamp: marketTimestamp.notNull(),
    imoexPrice: doublePrecision("imoex_price"),
    imoexChange: doublePrecision("imoex_change"),
    imoexVolume: doublePrecision("imoex_volume"),
  },
  (table) => [uniqueIndex("market_context_timestamp_uq").on(table.timestamp)],
);

export const features = pgTable(
  "features",
  {
    id: serial("id").primaryKey(),
    candleId: integer("candle_id").references(() => candles.id, {
      onDelete: "cascade",
    }),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timestamp: marketTimestamp.notNull(),
    priceChange1: doublePrecision("price_change_1"),
    priceChange3: doublePrecision("price_change_3"),
    priceChange5: doublePrecision("price_change_5"),
    priceChange10: doublePrecision("price_change_10"),
    priceChange15: doublePrecision("price_change_15"),
    priceChange30: doublePrecision("price_change_30"),
    priceChange60: doublePrecision("price_change_60"),
    acceleration: doublePrecision("acceleration"),
    distanceToHigh: doublePrecision("distance_to_high"),
    distanceToLow: doublePrecision("distance_to_low"),
    bodySize: doublePrecision("body_size"),
    upperShadow: doublePrecision("upper_shadow"),
    lowerShadow: doublePrecision("lower_shadow"),
    bodyToRange: doublePrecision("body_to_range"),
    greenStreak: integer("green_streak"),
    redStreak: integer("red_streak"),
    isDoji: integer("is_doji"),
    isHammer: integer("is_hammer"),
    isEngulfing: integer("is_engulfing"),
    isInsideBar: integer("is_inside_bar"),
    isOutsideBar: integer("is_outside_bar"),
    volume: doublePrecision("volume"),
    avgVolume20: doublePrecision("avg_volume_20"),
    relativeVolume: doublePrecision("relative_volume"),
    volumeSpike: integer("volume_spike"),
    atr: doublePrecision("atr"),
    candleRange: doublePrecision("candle_range"),
    volatilityChange: doublePrecision("volatility_change"),
    ema20: doublePrecision("ema_20"),
    ema50: doublePrecision("ema_50"),
    ema100: doublePrecision("ema_100"),
    ema200: doublePrecision("ema_200"),
    distanceToEma20: doublePrecision("distance_to_ema_20"),
    distanceToEma50: doublePrecision("distance_to_ema_50"),
    distanceToEma100: doublePrecision("distance_to_ema_100"),
    distanceToEma200: doublePrecision("distance_to_ema_200"),
    emaCross: varchar("ema_cross", { length: 32 }),
    trendStrength: doublePrecision("trend_strength"),
    rsi: doublePrecision("rsi"),
    macd: doublePrecision("macd"),
    macdSignal: doublePrecision("macd_signal"),
    macdHist: doublePrecision("macd_hist"),
    stochasticRsi: doublePrecision("stochastic_rsi"),
    cci: doublePrecision("cci"),
    williamsR: doublePrecision("williams_r"),
    bbUpper: doublePrecision("bb_upper"),
    bbMiddle: doublePrecision("bb_middle"),
    bbLower: doublePrecision("bb_lower"),
    bbWidth: doublePrecision("bb_width"),
    adx: doublePrecision("adx"),
    historicalVolatility: doublePrecision("historical_volatility"),
    vwap: doublePrecision("vwap"),
    obv: doublePrecision("obv"),
    mfi: doublePrecision("mfi"),
    accumulationDistribution: doublePrecision("accumulation_distribution"),
    volumeProfile: jsonb("volume_profile").$type<Record<string, number>>(),
  },
  (table) => [
    uniqueIndex("features_ticker_timestamp_uq").on(table.ticker, table.timestamp),
    index("features_ticker_timestamp_idx").on(table.ticker, table.timestamp),
  ],
);

export const patterns = pgTable(
  "patterns",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull().default("10m"),
    direction: varchar("direction", { length: 16 }),
    successRate: doublePrecision("success_rate"),
    profitFactor: doublePrecision("profit_factor"),
    occurrences: integer("occurrences").notNull().default(0),
    averageProfit: doublePrecision("average_profit"),
    isActive: boolean("is_active").notNull().default(true),
    discoveredAt: timestamp("discovered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("patterns_unique").on(
      table.ticker,
      table.name,
      table.timeframe,
      table.direction,
    ),
    index("patterns_ticker_success_idx").on(
      table.ticker,
      table.isActive,
      table.successRate,
    ),
  ],
);

export const downloadRuns = pgTable("download_runs", {
  id: serial("id").primaryKey(),
    status: varchar("status", { length: 32 }).notNull().default("running"),
  years: integer("years").notNull(),
  maxTickers: integer("max_tickers").notNull(),
  tickersProcessed: integer("tickers_processed").notNull().default(0),
  candlesLoaded: integer("candles_loaded").notNull().default(0),
  featuresCalculated: integer("features_calculated").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  errorMessage: text("error_message"),
});

export const marketInstruments = pgTable(
  "market_instruments",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    name: text("name").notNull(),
    category: varchar("category", { length: 32 }).notNull(),
    engine: varchar("engine", { length: 32 }).notNull(),
    market: varchar("market", { length: 32 }).notNull(),
    board: varchar("board", { length: 32 }).notNull(),
    secid: varchar("secid", { length: 64 }).notNull(),
    currency: varchar("currency", { length: 16 }),
    isActive: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("market_instruments_code_uq").on(table.code),
    index("market_instruments_category_idx").on(table.category, table.isActive),
  ],
);

export const marketObservations = pgTable(
  "market_observations",
  {
    id: serial("id").primaryKey(),
    instrumentId: integer("instrument_id")
      .notNull()
      .references(() => marketInstruments.id, { onDelete: "cascade" }),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    timestamp: marketTimestamp.notNull(),
    open: doublePrecision("open"),
    high: doublePrecision("high"),
    low: doublePrecision("low"),
    close: doublePrecision("close"),
    volume: doublePrecision("volume"),
    value: doublePrecision("value"),
    changePercent: doublePrecision("change_percent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("market_observations_unique").on(
      table.instrumentId,
      table.timeframe,
      table.timestamp,
    ),
    index("market_observations_lookup_idx").on(
      table.instrumentId,
      table.timestamp,
    ),
  ],
);

export const marketLevels = pgTable(
  "market_levels",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    levelType: varchar("level_type", { length: 32 }).notNull(),
    windowBars: integer("window_bars").notNull(),
    price: doublePrecision("price").notNull(),
    strength: doublePrecision("strength"),
    touches: integer("touches").notNull().default(0),
    calculatedAt: timestamp("calculated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("market_levels_unique").on(
      table.ticker,
      table.timeframe,
      table.levelType,
      table.windowBars,
    ),
    index("market_levels_lookup_idx").on(
      table.ticker,
      table.timeframe,
      table.levelType,
    ),
  ],
);

export const assetCorrelations = pgTable(
  "asset_correlations",
  {
    id: serial("id").primaryKey(),
    assetTicker: varchar("asset_ticker", { length: 32 }).notNull(),
    benchmarkTicker: varchar("benchmark_ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    windowBars: integer("window_bars").notNull(),
    correlation: doublePrecision("correlation"),
    sampleCount: integer("sample_count").notNull().default(0),
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }),
    periodEnd: timestamp("period_end", {
      withTimezone: true,
      mode: "date",
    }),
    calculatedAt: timestamp("calculated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("asset_correlations_unique").on(
      table.assetTicker,
      table.benchmarkTicker,
      table.timeframe,
      table.windowBars,
    ),
    index("asset_correlations_lookup_idx").on(
      table.assetTicker,
      table.timeframe,
    ),
  ],
);

export const macroIndicators = pgTable(
  "macro_indicators",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    name: text("name").notNull(),
    country: varchar("country", { length: 8 }).notNull().default("RU"),
    observedAt: date("observed_at").notNull(),
    value: doublePrecision("value").notNull(),
    unit: varchar("unit", { length: 32 }),
    source: varchar("source", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("macro_indicators_unique").on(
      table.code,
      table.observedAt,
      table.source,
    ),
    index("macro_indicators_code_date_idx").on(table.code, table.observedAt),
  ],
);

export const centralBankEvents = pgTable(
  "central_bank_events",
  {
    id: serial("id").primaryKey(),
    bank: varchar("bank", { length: 32 }).notNull().default("CBR"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    rateBefore: doublePrecision("rate_before"),
    rateAfter: doublePrecision("rate_after"),
    title: text("title"),
    source: varchar("source", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("central_bank_events_unique").on(
      table.bank,
      table.eventType,
      table.scheduledAt,
    ),
  ],
);

export const patternOccurrences = pgTable(
  "pattern_occurrences",
  {
    id: serial("id").primaryKey(),
    patternId: integer("pattern_id")
      .notNull()
      .references(() => patterns.id, { onDelete: "cascade" }),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    occurredAt: timestamp("timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    result15m: doublePrecision("result_15m"),
    result30m: doublePrecision("result_30m"),
    result1h: doublePrecision("result_1h"),
    result4h: doublePrecision("result_4h"),
    result1d: doublePrecision("result_1d"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("pattern_occurrences_unique").on(
      table.patternId,
      table.ticker,
      table.timeframe,
      table.occurredAt,
    ),
    index("pattern_occurrences_pattern_date_idx").on(
      table.patternId,
      table.occurredAt,
    ),
    index("pattern_occurrences_ticker_date_idx").on(
      table.ticker,
      table.occurredAt,
    ),
  ],
);

export const detectedPatterns = pgTable(
  "detected_patterns",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    startTimestamp: timestamp("start_timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    endTimestamp: timestamp("end_timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    patternType: varchar("pattern_type", { length: 96 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    confidence: doublePrecision("confidence").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>(),
    detectedAt: timestamp("detected_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("detected_patterns_unique").on(
      table.ticker,
      table.timeframe,
      table.startTimestamp,
      table.endTimestamp,
      table.patternType,
      table.direction,
    ),
    index("detected_patterns_ticker_end_idx").on(
      table.ticker,
      table.timeframe,
      table.endTimestamp,
    ),
    index("detected_patterns_type_idx").on(
      table.patternType,
      table.direction,
      table.timeframe,
    ),
  ],
);

export const patternStatistics = pgTable(
  "pattern_statistics",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    patternType: varchar("pattern_type", { length: 96 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    occurrences: integer("occurrences").notNull().default(0),
    winRate: doublePrecision("win_rate"),
    profitFactor: doublePrecision("profit_factor"),
    expectancy: doublePrecision("expectancy"),
    averageProfit: doublePrecision("average_profit"),
    averageLoss: doublePrecision("average_loss"),
    maxDrawdown: doublePrecision("max_drawdown"),
    bestTakeProfit: doublePrecision("best_take_profit"),
    bestStopLoss: doublePrecision("best_stop_loss"),
    bestHoldingMinutes: integer("best_holding_minutes"),
    pValue: doublePrecision("p_value"),
    qValue: doublePrecision("q_value"),
    confidenceLow: doublePrecision("confidence_low"),
    confidenceHigh: doublePrecision("confidence_high"),
    trainWinRate: doublePrecision("train_win_rate"),
    testWinRate: doublePrecision("test_win_rate"),
    trainExpectancy: doublePrecision("train_expectancy"),
    testExpectancy: doublePrecision("test_expectancy"),
    isSignificant: boolean("is_significant").notNull().default(false),
    calculatedAt: timestamp("calculated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("pattern_statistics_unique").on(
      table.ticker,
      table.timeframe,
      table.patternType,
      table.direction,
    ),
    index("pattern_statistics_lookup_idx").on(
      table.ticker,
      table.timeframe,
      table.isSignificant,
      table.winRate,
    ),
  ],
);

export const featureCombinations = pgTable(
  "feature_combinations",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    conditions: jsonb("conditions")
      .notNull()
      .$type<Record<string, unknown>[]>(),
    occurrences: integer("occurrences").notNull().default(0),
    successRate: doublePrecision("success_rate"),
    averageProfit: doublePrecision("average_profit"),
    averageLoss: doublePrecision("average_loss"),
    expectedValue: doublePrecision("expected_value"),
    profitFactor: doublePrecision("profit_factor"),
    sharpeRatio: doublePrecision("sharpe_ratio"),
    pValue: doublePrecision("p_value"),
    confidenceLow: doublePrecision("confidence_low"),
    confidenceHigh: doublePrecision("confidence_high"),
    maxDrawdown: doublePrecision("max_drawdown"),
    holdingMinutes: integer("holding_minutes"),
    direction: varchar("direction", { length: 16 }),
    bestTakeProfit: doublePrecision("best_take_profit"),
    bestStopLoss: doublePrecision("best_stop_loss"),
    bestHoldingMinutes: integer("best_holding_minutes"),
    trainWinRate: doublePrecision("train_win_rate"),
    testWinRate: doublePrecision("test_win_rate"),
    trainExpectedValue: doublePrecision("train_expected_value"),
    testExpectedValue: doublePrecision("test_expected_value"),
    testProfitFactor: doublePrecision("test_profit_factor"),
    statisticalSignificance: boolean("statistical_significance")
      .notNull()
      .default(false),
    discoveredAt: timestamp("discovered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("feature_combinations_name_uq").on(table.name),
    index("feature_combinations_quality_idx").on(
      table.isActive,
      table.successRate,
      table.occurrences,
    ),
  ],
);

export const signalsHistory = pgTable(
  "signals_history",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    candleTimestamp: marketTimestamp.notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    confidence: doublePrecision("confidence").notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    stopPrice: doublePrecision("stop_price"),
    targetPrice: doublePrecision("target_price"),
    horizonMinutes: integer("horizon_minutes"),
    reasons: jsonb("reasons").$type<string[]>(),
    patternIds: integer("pattern_ids").array(),
    combinationIds: integer("combination_ids").array(),
    outcome: varchar("outcome", { length: 16 }),
    outcomePercent: doublePrecision("outcome_percent"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("signals_history_ticker_generated_idx").on(
      table.ticker,
      table.generatedAt,
    ),
    index("signals_history_confidence_idx").on(
      table.direction,
      table.confidence,
    ),
  ],
);

export const telegramCommoditySubscriptions = pgTable(
  "telegram_commodity_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const telegramCryptoSubscriptions = pgTable(
  "telegram_crypto_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const telegramMoneyTestSubscriptions = pgTable(
  "telegram_money_test_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const telegramSmartMoneySubscriptions = pgTable(
  "telegram_smart_money_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const telegramAlphaSubscriptions = pgTable(
  "telegram_alpha_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const telegramMovementSubscriptions = pgTable(
  "telegram_movement_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const telegramPositionSettings = pgTable(
  "telegram_position_settings",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    bankRub: doublePrecision("bank_rub").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

export const strategyResults = pgTable(
  "strategy_results",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    version: varchar("version", { length: 32 }).notNull().default("1"),
    conditions: jsonb("conditions")
      .notNull()
      .$type<Record<string, unknown>[]>(),
    winRate: doublePrecision("win_rate"),
    profitFactor: doublePrecision("profit_factor"),
    expectedValue: doublePrecision("expected_value"),
    sharpeRatio: doublePrecision("sharpe_ratio"),
    pValue: doublePrecision("p_value"),
    confidenceLow: doublePrecision("confidence_low"),
    confidenceHigh: doublePrecision("confidence_high"),
    maxDrawdown: doublePrecision("max_drawdown"),
    averageProfit: doublePrecision("average_profit"),
    averageLoss: doublePrecision("average_loss"),
    bestTimeframe: varchar("best_timeframe", { length: 16 }),
    bestTakeProfit: doublePrecision("best_take_profit"),
    bestStopLoss: doublePrecision("best_stop_loss"),
    bestHoldingMinutes: integer("best_holding_minutes"),
    trainWinRate: doublePrecision("train_win_rate"),
    testWinRate: doublePrecision("test_win_rate"),
    trainExpectedValue: doublePrecision("train_expected_value"),
    testExpectedValue: doublePrecision("test_expected_value"),
    testProfitFactor: doublePrecision("test_profit_factor"),
    statisticalSignificance: boolean("statistical_significance")
      .notNull()
      .default(false),
    tradesCount: integer("trades_count").notNull().default(0),
    evaluatedAt: timestamp("evaluated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("strategy_results_name_version_uq").on(table.name, table.version),
    index("strategy_results_quality_idx").on(table.winRate, table.profitFactor),
  ],
);

export const backtestResults = pgTable(
  "backtest_results",
  {
    id: serial("id").primaryKey(),
    strategyId: integer("strategy_id").references(() => strategyResults.id, {
      onDelete: "cascade",
    }),
    ticker: varchar("ticker", { length: 32 }),
    timeframe: varchar("timeframe", { length: 16 }).notNull(),
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    periodEnd: timestamp("period_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    tradesCount: integer("trades_count").notNull().default(0),
    winRate: doublePrecision("win_rate"),
    profitFactor: doublePrecision("profit_factor"),
    maxDrawdown: doublePrecision("max_drawdown"),
    averageProfit: doublePrecision("average_profit"),
    averageLoss: doublePrecision("average_loss"),
    expectedValue: doublePrecision("expected_value"),
    sharpeRatio: doublePrecision("sharpe_ratio"),
    pValue: doublePrecision("p_value"),
    confidenceLow: doublePrecision("confidence_low"),
    confidenceHigh: doublePrecision("confidence_high"),
    netReturn: doublePrecision("net_return"),
    equityCurve: jsonb("equity_curve").$type<
      { timestamp: string; equity: number }[]
    >(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("backtest_results_strategy_period_idx").on(
      table.strategyId,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);

// ── Per-Stock Setup Scanner ──────────────────────────────────────────────────

export const stockSetups = pgTable(
  "stock_setups",
  {
    id: serial("id").primaryKey(),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    setupIndex: integer("setup_index").notNull(),
    direction: varchar("direction", { length: 8 }).notNull().default("LONG"),
    conditions: jsonb("conditions")
      .notNull()
      .$type<{ feature: string; label: string }[]>(),
    targetPercent: doublePrecision("target_percent").notNull(),
    horizonBars: integer("horizon_bars").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    trainOccurrences: integer("train_occurrences"),
    trainWinRate: doublePrecision("train_win_rate"),
    valOccurrences: integer("val_occurrences"),
    valWinRate: doublePrecision("val_win_rate"),
    testOccurrences: integer("test_occurrences"),
    testWinRate: doublePrecision("test_win_rate"),
    testAvgReturn: doublePrecision("test_avg_return"),
    testMedianReturn: doublePrecision("test_median_return"),
    testProfitFactor: doublePrecision("test_profit_factor"),
    testMaxDrawdown: doublePrecision("test_max_drawdown"),
    testAvgMae: doublePrecision("test_avg_mae"),
    testAvgMfe: doublePrecision("test_avg_mfe"),
    confidence: doublePrecision("confidence"),
    discoveredAt: timestamp("discovered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_setups_ticker_idx_dir_target_uq").on(
      table.ticker,
      table.setupIndex,
      table.direction,
      table.targetPercent,
    ),
    index("stock_setups_active_conf_idx").on(
      table.ticker,
      table.isActive,
      table.confidence,
    ),
  ],
);

export const liveSetupMatches = pgTable(
  "live_setup_matches",
  {
    id: serial("id").primaryKey(),
    setupId: integer("setup_id")
      .notNull()
      .references(() => stockSetups.id, { onDelete: "cascade" }),
    ticker: varchar("ticker", { length: 32 }).notNull(),
    matchedAt: timestamp("matched_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    currentPrice: doublePrecision("current_price").notNull(),
    confidenceScore: doublePrecision("confidence_score").notNull(),
    matchDetails: jsonb("match_details").$type<Record<string, unknown>>(),
    notifiedAt: timestamp("notified_at", {
      withTimezone: true,
      mode: "date",
    }),
    signalId: integer("signal_id"),
  },
  (table) => [
    index("live_setup_matches_matched_idx").on(table.matchedAt),
    index("live_setup_matches_ticker_matched_idx").on(
      table.ticker,
      table.matchedAt,
    ),
  ],
);

export const telegramSetupSubscriptions = pgTable(
  "telegram_setup_subscriptions",
  {
    chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
    subscribedAt: timestamp("subscribed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

// ────────────────────────────────────────────────────────────────────────────

export const insertMoexTickerSchema = createInsertSchema(moexTickers).omit({
  id: true,
});
export const insertCandleSchema = createInsertSchema(candles).omit({ id: true });
export const insertFeatureSchema = createInsertSchema(features).omit({ id: true });
export const insertMarketContextSchema = createInsertSchema(marketContext).omit({
  id: true,
});
export const insertPatternSchema = createInsertSchema(patterns).omit({ id: true });

export type MoexTicker = typeof moexTickers.$inferSelect;
export type Candle = typeof candles.$inferSelect;
export type Feature = typeof features.$inferSelect;
export type MarketContext = typeof marketContext.$inferSelect;
export type Pattern = typeof patterns.$inferSelect;
export type DownloadRun = typeof downloadRuns.$inferSelect;
export type MarketInstrument = typeof marketInstruments.$inferSelect;
export type MarketObservation = typeof marketObservations.$inferSelect;
export type MacroIndicator = typeof macroIndicators.$inferSelect;
export type CentralBankEvent = typeof centralBankEvents.$inferSelect;
export type PatternOccurrence = typeof patternOccurrences.$inferSelect;
export type DetectedPattern = typeof detectedPatterns.$inferSelect;
export type PatternStatistic = typeof patternStatistics.$inferSelect;
export type FeatureCombination = typeof featureCombinations.$inferSelect;
export type SignalHistory = typeof signalsHistory.$inferSelect;
export type TelegramCommoditySubscription =
  typeof telegramCommoditySubscriptions.$inferSelect;
export type TelegramCryptoSubscription =
  typeof telegramCryptoSubscriptions.$inferSelect;
export type TelegramMoneyTestSubscription =
  typeof telegramMoneyTestSubscriptions.$inferSelect;
export type TelegramPositionSetting = typeof telegramPositionSettings.$inferSelect;
export type StrategyResult = typeof strategyResults.$inferSelect;
export type BacktestResult = typeof backtestResults.$inferSelect;
export type StockSetup = typeof stockSetups.$inferSelect;
export type LiveSetupMatch = typeof liveSetupMatches.$inferSelect;
export type TelegramSetupSubscription =
  typeof telegramSetupSubscriptions.$inferSelect;
export type InsertCandle = z.infer<typeof insertCandleSchema>;