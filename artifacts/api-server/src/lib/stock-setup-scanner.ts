/**
 * Per-Stock Setup Scanner — Real-Time Phase
 *
 * Каждый цикл:
 *  1. Загружает активные сетапы из stock_setups.
 *  2. Получает последние признаки для каждого тикера.
 *  3. Проверяет совпадение с условиями каждого сетапа.
 *  4. Сохраняет совпадения в live_setup_matches.
 *  5. Возвращает топ-совпадения для Telegram.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

type SetupCondition = { feature: string; label: string };

type ActiveSetup = {
  id: number;
  ticker: string;
  setupIndex: number;
  direction: string;
  conditions: SetupCondition[];
  targetPercent: number;
  horizonBars: number;
  trainWinRate: number | null;
  valWinRate: number | null;
  testWinRate: number | null;
  testOccurrences: number | null;
  testAvgReturn: number | null;
  testMedianReturn: number | null;
  testProfitFactor: number | null;
  confidence: number | null;
};

type LatestFeature = {
  ticker: string;
  timestamp: Date;
  close: number;
  high: number;
  low: number;
  volume: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  vwap: number | null;
  relativeVolume: number | null;
  volumeSpike: number | null;
  adx: number | null;
  bbMiddle: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  priceChange60: number | null;
  imoexChange: number | null;
};

export type SetupMatchResult = {
  setupId: number;
  ticker: string;
  setupIndex: number;
  direction: string;
  targetPercent: number;
  horizonBars: number;
  currentPrice: number;
  confidenceScore: number;
  matchedConditions: string[];
  testWinRate: number | null;
  testOccurrences: number | null;
  testAvgReturn: number | null;
  testMedianReturn: number | null;
  testProfitFactor: number | null;
  trainWinRate: number | null;
  valWinRate: number | null;
  matchedAt: Date;
};

// ── Condition evaluator ───────────────────────────────────────────────────────

function evaluateCondition(feature: string, f: LatestFeature): boolean {
  switch (feature) {
    case "rsi_low":        return (f.rsi ?? 50) < 35;
    case "rsi_mid":        return (f.rsi ?? 50) >= 35 && (f.rsi ?? 50) <= 65;
    case "rsi_high":       return (f.rsi ?? 50) > 65;
    case "ema_up":         return (f.ema20 ?? 0) > (f.ema50 ?? 0);
    case "ema_strong_up":  return (f.ema50 ?? 0) > (f.ema100 ?? 0);
    case "ema_down":       return (f.ema20 ?? 0) < (f.ema50 ?? 0);
    case "macd_bull":      return (f.macd ?? 0) > (f.macdSignal ?? 0);
    case "macd_bear":      return (f.macd ?? 0) < (f.macdSignal ?? 0);
    case "vol_elevated":   return (f.relativeVolume ?? 1) >= 1.5;
    case "vol_spike":      return (f.relativeVolume ?? 1) >= 2.5;
    case "vol_low":        return (f.relativeVolume ?? 1) < 0.7;
    case "above_vwap":     return f.vwap !== null && f.close > f.vwap;
    case "below_vwap":     return f.vwap !== null && f.close < f.vwap;
    case "adx_trending":   return (f.adx ?? 0) > 25;
    case "adx_strong":     return (f.adx ?? 0) > 35;
    case "bb_above_mid":   return f.bbMiddle !== null && f.close > f.bbMiddle;
    case "bb_near_low":    return f.bbLower !== null && f.close < f.bbLower;
    case "bb_near_high":   return f.bbUpper !== null && f.close > f.bbUpper;
    case "mom_pos_1h":     return (f.priceChange60 ?? 0) > 0;
    case "mom_pos_str":    return (f.priceChange60 ?? 0) > 0.3;
    case "mom_neg_str":    return (f.priceChange60 ?? 0) < -0.3;
    case "imoex_up":       return (f.imoexChange ?? 0) > 0.2;
    case "imoex_down":     return (f.imoexChange ?? 0) < -0.2;
    default: return false;
  }
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadActiveSetups(): Promise<ActiveSetup[]> {
  const rows = await db.execute<{
    id: string;
    ticker: string;
    setup_index: string;
    direction: string;
    conditions: string;
    target_percent: string;
    horizon_bars: string;
    train_win_rate: string | null;
    val_win_rate: string | null;
    test_win_rate: string | null;
    test_occurrences: string | null;
    test_avg_return: string | null;
    test_median_return: string | null;
    test_profit_factor: string | null;
    confidence: string | null;
  }>(sql`
    SELECT id, ticker, setup_index, direction, conditions, target_percent,
           horizon_bars, train_win_rate, val_win_rate, test_win_rate,
           test_occurrences, test_avg_return, test_median_return,
           test_profit_factor, confidence
    FROM stock_setups
    WHERE is_active = true
    ORDER BY confidence DESC NULLS LAST
  `);

  return rows.rows.map((r) => ({
    id: Number(r.id),
    ticker: r.ticker,
    setupIndex: Number(r.setup_index),
    direction: r.direction,
    conditions: (typeof r.conditions === "string"
      ? JSON.parse(r.conditions)
      : r.conditions) as SetupCondition[],
    targetPercent: Number(r.target_percent),
    horizonBars: Number(r.horizon_bars),
    trainWinRate: r.train_win_rate !== null ? Number(r.train_win_rate) : null,
    valWinRate: r.val_win_rate !== null ? Number(r.val_win_rate) : null,
    testWinRate: r.test_win_rate !== null ? Number(r.test_win_rate) : null,
    testOccurrences: r.test_occurrences !== null ? Number(r.test_occurrences) : null,
    testAvgReturn: r.test_avg_return !== null ? Number(r.test_avg_return) : null,
    testMedianReturn: r.test_median_return !== null ? Number(r.test_median_return) : null,
    testProfitFactor: r.test_profit_factor !== null ? Number(r.test_profit_factor) : null,
    confidence: r.confidence !== null ? Number(r.confidence) : null,
  }));
}

async function loadLatestFeatures(): Promise<LatestFeature[]> {
  const rows = await db.execute<{
    ticker: string;
    ts: string;
    close: string;
    high: string;
    low: string;
    volume: string;
    rsi: string | null;
    macd: string | null;
    macd_signal: string | null;
    ema20: string | null;
    ema50: string | null;
    ema100: string | null;
    vwap: string | null;
    relative_volume: string | null;
    volume_spike: string | null;
    adx: string | null;
    bb_middle: string | null;
    bb_upper: string | null;
    bb_lower: string | null;
    price_change_60: string | null;
    imoex_change: string | null;
  }>(sql`
    WITH latest_candles AS (
      SELECT DISTINCT ON (c.ticker)
        c.ticker, c.timestamp, c.close, c.high, c.low, c.volume, c.id
      FROM candles c
      WHERE c.timeframe = '10m'
        AND c.source = 'moex_iss'
        AND c.ticker <> 'IMOEX'
        AND c.timestamp >= now() - interval '4 hours'
      ORDER BY c.ticker, c.timestamp DESC
    )
    SELECT
      lc.ticker,
      lc.timestamp AS ts,
      lc.close,
      lc.high,
      lc.low,
      lc.volume,
      f.rsi,
      f.macd,
      f.macd_signal,
      f.ema_20  AS ema20,
      f.ema_50  AS ema50,
      f.ema_100 AS ema100,
      f.vwap,
      f.relative_volume,
      f.volume_spike,
      f.adx,
      f.bb_middle,
      f.bb_upper,
      f.bb_lower,
      f.price_change_60,
      mc.imoex_change
    FROM latest_candles lc
    JOIN features f ON f.candle_id = lc.id
    LEFT JOIN LATERAL (
      SELECT imoex_change
      FROM market_context mc2
      WHERE mc2.timestamp <= lc.timestamp
      ORDER BY mc2.timestamp DESC
      LIMIT 1
    ) mc ON true
  `);

  return rows.rows.map((r) => ({
    ticker: r.ticker,
    timestamp: new Date(r.ts),
    close: Number(r.close),
    high: Number(r.high),
    low: Number(r.low),
    volume: Number(r.volume),
    rsi: r.rsi !== null ? Number(r.rsi) : null,
    macd: r.macd !== null ? Number(r.macd) : null,
    macdSignal: r.macd_signal !== null ? Number(r.macd_signal) : null,
    ema20: r.ema20 !== null ? Number(r.ema20) : null,
    ema50: r.ema50 !== null ? Number(r.ema50) : null,
    ema100: r.ema100 !== null ? Number(r.ema100) : null,
    vwap: r.vwap !== null ? Number(r.vwap) : null,
    relativeVolume: r.relative_volume !== null ? Number(r.relative_volume) : null,
    volumeSpike: r.volume_spike !== null ? Number(r.volume_spike) : null,
    adx: r.adx !== null ? Number(r.adx) : null,
    bbMiddle: r.bb_middle !== null ? Number(r.bb_middle) : null,
    bbUpper: r.bb_upper !== null ? Number(r.bb_upper) : null,
    bbLower: r.bb_lower !== null ? Number(r.bb_lower) : null,
    priceChange60: r.price_change_60 !== null ? Number(r.price_change_60) : null,
    imoexChange: r.imoex_change !== null ? Number(r.imoex_change) : null,
  }));
}

// ── Core scan ─────────────────────────────────────────────────────────────────

export async function scanStockSetups(): Promise<SetupMatchResult[]> {
  const [setups, features] = await Promise.all([
    loadActiveSetups(),
    loadLatestFeatures(),
  ]);

  if (setups.length === 0 || features.length === 0) return [];

  const featureByTicker = new Map<string, LatestFeature>();
  for (const f of features) featureByTicker.set(f.ticker, f);

  const matches: SetupMatchResult[] = [];
  const now = new Date();

  for (const setup of setups) {
    const feature = featureByTicker.get(setup.ticker);
    if (!feature) continue;

    // Check all conditions
    const allMatch = setup.conditions.every((cond) =>
      evaluateCondition(cond.feature, feature),
    );
    if (!allMatch) continue;

    // Confidence score: setup confidence + bonus for fresh volume
    const baseConf = setup.confidence ?? 50;
    const volBonus = (feature.relativeVolume ?? 1) >= 2 ? 5 : 0;
    const imoexBonus =
      setup.direction === "LONG" && (feature.imoexChange ?? 0) > 0.3 ? 5 : 0;
    const confidenceScore = Math.min(100, baseConf + volBonus + imoexBonus);

    matches.push({
      setupId: setup.id,
      ticker: setup.ticker,
      setupIndex: setup.setupIndex,
      direction: setup.direction,
      targetPercent: setup.targetPercent,
      horizonBars: setup.horizonBars,
      currentPrice: feature.close,
      confidenceScore,
      matchedConditions: setup.conditions.map((c) => c.label),
      testWinRate: setup.testWinRate,
      testOccurrences: setup.testOccurrences,
      testAvgReturn: setup.testAvgReturn,
      testMedianReturn: setup.testMedianReturn,
      testProfitFactor: setup.testProfitFactor,
      trainWinRate: setup.trainWinRate,
      valWinRate: setup.valWinRate,
      matchedAt: now,
    });
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidenceScore - a.confidenceScore);

  // Persist matches (upsert — avoid duplicate notifications within 4h)
  if (matches.length > 0) {
    await db.execute(sql`
      INSERT INTO live_setup_matches
        (setup_id, ticker, matched_at, current_price, confidence_score, match_details)
      SELECT
        v.setup_id::int,
        v.ticker,
        now(),
        v.current_price::double precision,
        v.confidence_score::double precision,
        v.match_details::jsonb
      FROM (VALUES ${sql.raw(
        matches
          .slice(0, 20)
          .map(
            (m) =>
              `(${m.setupId}, '${m.ticker}', ${m.currentPrice}, ${m.confidenceScore}, '${JSON.stringify({ conditions: m.matchedConditions }).replace(/'/g, "''")}')`,
          )
          .join(", "),
      )}) AS v(setup_id, ticker, current_price, confidence_score, match_details)
      WHERE NOT EXISTS (
        SELECT 1 FROM live_setup_matches lsm
        WHERE lsm.setup_id = v.setup_id::int
          AND lsm.matched_at >= now() - interval '4 hours'
      )
    `);
  }

  return matches;
}

// ── Text formatter for Telegram ───────────────────────────────────────────────

const BARS_PER_DAY = 53;

function horizonLabel(bars: number): string {
  const days = Math.round(bars / BARS_PER_DAY);
  return days === 1 ? "1 день" : days === 2 ? "2 дня" : `${days} дня`;
}

function pct(v: number | null, digits = 1): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function num(v: number | null, digits = 2, suffix = ""): string {
  if (v === null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}${suffix}`;
}

export function formatSetupMatch(m: SetupMatchResult): string {
  const emoji = m.confidenceScore >= 70 ? "🟢" : m.confidenceScore >= 55 ? "🟡" : "🔴";
  const lines: string[] = [
    `${emoji} ${m.ticker} — HISTORICAL SETUP MATCH`,
    ``,
    `Цена: ${m.currentPrice.toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽`,
    ``,
    `SETUP: ${m.ticker} #${m.setupIndex}`,
    `Цель: +${m.targetPercent}%`,
    `Горизонт: ${horizonLabel(m.horizonBars)}`,
    ``,
    `━━━━━━━━━━━━`,
    `ТЕКУЩЕЕ СОВПАДЕНИЕ`,
    ``,
    ...m.matchedConditions.map((c) => `• ${c}`),
    ``,
    `━━━━━━━━━━━━`,
    `ИСТОРИЧЕСКИЙ РЕЗУЛЬТАТ`,
    ``,
  ];

  const wr = m.testWinRate ?? m.trainWinRate;
  if (wr !== null) {
    lines.push(`Win Rate: ${pct(wr, 1)}`);
  }
  if (m.testOccurrences !== null) {
    lines.push(`Случаев в тесте: ${m.testOccurrences}`);
  }
  if (m.testAvgReturn !== null) {
    lines.push(`Ср. доходность: ${num(m.testAvgReturn)}%`);
  }
  if (m.testMedianReturn !== null) {
    lines.push(`Медиана: ${num(m.testMedianReturn)}%`);
  }
  if (m.testProfitFactor !== null) {
    lines.push(`Profit Factor: ${m.testProfitFactor.toFixed(2)}`);
  }
  if (m.trainWinRate !== null && m.valWinRate !== null) {
    lines.push(`Train / Val: ${pct(m.trainWinRate, 1)} / ${pct(m.valWinRate, 1)}`);
  }
  lines.push(``, `━━━━━━━━━━━━`, `CONFIDENCE: ${m.confidenceScore}/100`);

  const status =
    m.confidenceScore >= 70
      ? "🟢 Сильный исторический сетап"
      : m.confidenceScore >= 55
        ? "🟡 Умеренный сетап"
        : "🔴 Слабый сетап";
  lines.push(`Статус: ${status}`);

  return lines.join("\n");
}

export function formatSetupRanking(matches: SetupMatchResult[]): string {
  if (matches.length === 0) {
    return [
      "📈 Сетапы IMOEX",
      "",
      "Сейчас совпадений с историческими сетапами нет.",
      "",
      "Сетапы обновляются каждые 10 минут в торговые часы.",
      "Чтобы открыть базу сетапов — используйте команду /setups_stats",
    ].join("\n");
  }

  const top = matches.slice(0, 5);
  const header = [
    "📈 ТОП СЕТАПОВ IMOEX",
    `(обновлено ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })})`,
    "",
    "━━━━━━━━━━━━",
  ];

  const items = top.map((m, i) => {
    const wr = m.testWinRate ?? m.trainWinRate;
    const wrStr = wr !== null ? ` · WR ${pct(wr, 0)}` : "";
    const emoji = m.confidenceScore >= 70 ? "🟢" : m.confidenceScore >= 55 ? "🟡" : "🔴";
    return `#${i + 1} ${emoji} ${m.ticker} — ${m.confidenceScore}/100${wrStr}\n   Цель: +${m.targetPercent}% · ${horizonLabel(m.horizonBars)}\n   ${m.matchedConditions.join(", ")}`;
  });

  return [...header, ...items, "", `Всего совпадений: ${matches.length}`].join("\n");
}

// ── Live setup stats (for /setups_stats) ─────────────────────────────────────

export async function getSetupsStats(): Promise<string> {
  const counts = await db.execute<{
    ticker: string;
    cnt: string;
    best_conf: string | null;
    best_wr: string | null;
  }>(sql`
    SELECT ticker,
           count(*) AS cnt,
           max(confidence)::text AS best_conf,
           max(test_win_rate)::text AS best_wr
    FROM stock_setups
    WHERE is_active = true
    GROUP BY ticker
    ORDER BY max(confidence) DESC NULLS LAST
    LIMIT 25
  `);

  if (counts.rows.length === 0) {
    return [
      "📊 База сетапов пуста.",
      "",
      "Запустите обнаружение сетапов:",
      "`pnpm --filter @workspace/scripts run discover-setups`",
    ].join("\n");
  }

  const total = await db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM stock_setups WHERE is_active = true
  `);
  const totalN = Number(total.rows[0]?.n ?? 0);

  const rows = counts.rows
    .map((r) => {
      const wr = r.best_wr !== null ? ` · WR ${(Number(r.best_wr) * 100).toFixed(0)}%` : "";
      const conf = r.best_conf !== null ? ` · ${Math.round(Number(r.best_conf))}/100` : "";
      return `${r.ticker}: ${r.cnt} сет.${conf}${wr}`;
    })
    .join("\n");

  return [
    `📊 База сетапов IMOEX`,
    `Всего: ${totalN} активных сетапов`,
    "",
    rows,
    counts.rows.length < totalN / 1 ? "\n…и другие" : "",
  ].join("\n");
}
