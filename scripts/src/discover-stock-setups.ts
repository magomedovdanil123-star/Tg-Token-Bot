/**
 * Per-Stock Setup Scanner — Discovery Phase
 *
 * Для каждой акции IMOEX (у которой достаточно исторических данных):
 *  1. Загружает 10m свечи + признаки за последний год из БД.
 *  2. Размечает каждую свечу: достигнута ли цель +1.5% / +2% за 1/2/3 дня
 *     (1 торговый день MOEX ≈ 53 бара по 10m) без look-ahead bias.
 *  3. Переводит признаки в 22 бинарных условия.
 *  4. Ищет одиночные и парные условия с высоким win rate.
 *  5. Walk-forward валидация: train 70% / val 15% / test 15%.
 *  6. Сохраняет прошедшие фильтр сетапы в таблицу stock_setups.
 *
 * Запуск: pnpm --filter @workspace/scripts run discover-setups
 * Флаги:
 *   --ticker=SBER       — обрабатывать только один тикер
 *   --target=1.5        — искать только эту цель (1.5 или 2.0)
 *   --min-occurrences=25
 *   --min-win-rate=0.60
 */

import { db, stockSetups } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);

const ONLY_TICKER = args["ticker"]?.toUpperCase();
const ONLY_TARGET = args["target"] ? Number(args["target"]) : undefined;
const MIN_OCC = Number(args["min-occurrences"] ?? 25);
const MIN_WR = Number(args["min-win-rate"] ?? 0.60);

// ── Constants ─────────────────────────────────────────────────────────────────

/** 1 торговый день MOEX ≈ 53 бара по 10m (10:00–18:50) */
const BARS_PER_DAY = 53;
const HORIZONS = [
  { label: "1d", bars: BARS_PER_DAY },
  { label: "2d", bars: BARS_PER_DAY * 2 },
  { label: "3d", bars: BARS_PER_DAY * 3 },
] as const;

const TARGETS = [1.5, 2.0];

// Комиссия туда-обратно в %
const COST_PCT = 0.2;

// ── Binary conditions ─────────────────────────────────────────────────────────

type ConditionDef = {
  feature: string;
  label: string;
  test: (row: FeatureRow) => boolean;
};

type FeatureRow = {
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
  priceChange1: number | null;
  priceChange5: number | null;
  priceChange15: number | null;
  priceChange60: number | null;
  distanceToHigh: number | null;
  distanceToLow: number | null;
  imoexChange: number | null; // from market_context
};

const CONDITIONS: ConditionDef[] = [
  // RSI
  { feature: "rsi_low",  label: "RSI < 35",       test: (r) => (r.rsi ?? 50) < 35 },
  { feature: "rsi_mid",  label: "RSI 35–65",       test: (r) => (r.rsi ?? 50) >= 35 && (r.rsi ?? 50) <= 65 },
  { feature: "rsi_high", label: "RSI > 65",        test: (r) => (r.rsi ?? 50) > 65 },
  // EMA trend
  { feature: "ema_up",       label: "EMA20 > EMA50",   test: (r) => (r.ema20 ?? 0) > (r.ema50 ?? 0) },
  { feature: "ema_strong_up",label: "EMA50 > EMA100",  test: (r) => (r.ema50 ?? 0) > (r.ema100 ?? 0) },
  { feature: "ema_down",     label: "EMA20 < EMA50",   test: (r) => (r.ema20 ?? 0) < (r.ema50 ?? 0) },
  // MACD
  { feature: "macd_bull",    label: "MACD > сигнал",   test: (r) => (r.macd ?? 0) > (r.macdSignal ?? 0) },
  { feature: "macd_bear",    label: "MACD < сигнал",   test: (r) => (r.macd ?? 0) < (r.macdSignal ?? 0) },
  // Volume
  { feature: "vol_elevated", label: "RelVol ≥ 1.5x",  test: (r) => (r.relativeVolume ?? 1) >= 1.5 },
  { feature: "vol_spike",    label: "RelVol ≥ 2.5x",  test: (r) => (r.relativeVolume ?? 1) >= 2.5 },
  { feature: "vol_low",      label: "RelVol < 0.7x",  test: (r) => (r.relativeVolume ?? 1) < 0.7 },
  // VWAP
  { feature: "above_vwap",   label: "Цена > VWAP",    test: (r) => r.vwap !== null && r.close > r.vwap },
  { feature: "below_vwap",   label: "Цена < VWAP",    test: (r) => r.vwap !== null && r.close < r.vwap },
  // ADX
  { feature: "adx_trending", label: "ADX > 25",       test: (r) => (r.adx ?? 0) > 25 },
  { feature: "adx_strong",   label: "ADX > 35",       test: (r) => (r.adx ?? 0) > 35 },
  // Bollinger Bands
  { feature: "bb_above_mid", label: "Цена > BB-mid",  test: (r) => r.bbMiddle !== null && r.close > r.bbMiddle },
  { feature: "bb_near_low",  label: "Цена < BB-low",  test: (r) => r.bbLower !== null && r.close < r.bbLower },
  { feature: "bb_near_high", label: "Цена > BB-high", test: (r) => r.bbUpper !== null && r.close > r.bbUpper },
  // Price momentum
  { feature: "mom_pos_1h",   label: "Доходность 1ч > 0",     test: (r) => (r.priceChange60 ?? 0) > 0 },
  { feature: "mom_pos_str",  label: "Доходность 1ч > 0.3%",  test: (r) => (r.priceChange60 ?? 0) > 0.3 },
  { feature: "mom_neg_str",  label: "Доходность 1ч < -0.3%", test: (r) => (r.priceChange60 ?? 0) < -0.3 },
  // IMOEX context
  { feature: "imoex_up",     label: "IMOEX растёт",          test: (r) => (r.imoexChange ?? 0) > 0.2 },
  { feature: "imoex_down",   label: "IMOEX падает",          test: (r) => (r.imoexChange ?? 0) < -0.2 },
];

const N_CONDITIONS = CONDITIONS.length;

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadTickers(): Promise<string[]> {
  const rows = await db.execute<{ ticker: string; cnt: string }>(sql`
    SELECT c.ticker, count(*) AS cnt
    FROM candles c
    WHERE c.timeframe = '10m' AND c.source = 'moex_iss'
      AND c.ticker <> 'IMOEX'
    GROUP BY c.ticker
    HAVING count(*) >= 1000
    ORDER BY c.ticker
  `);
  return rows.rows.map((r) => r.ticker);
}

async function loadTickerData(ticker: string): Promise<FeatureRow[]> {
  const since = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // 400 дней с запасом
  const rows = await db.execute<{
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
    price_change_1: string | null;
    price_change_5: string | null;
    price_change_15: string | null;
    price_change_60: string | null;
    distance_to_high: string | null;
    distance_to_low: string | null;
    imoex_change: string | null;
  }>(sql`
    SELECT
      c.timestamp          AS ts,
      c.close,
      c.high,
      c.low,
      c.volume,
      f.rsi,
      f.macd,
      f.macd_signal,
      f.ema_20             AS ema20,
      f.ema_50             AS ema50,
      f.ema_100            AS ema100,
      f.vwap,
      f.relative_volume,
      f.volume_spike,
      f.adx,
      f.bb_middle,
      f.bb_upper,
      f.bb_lower,
      f.price_change_1,
      f.price_change_5,
      f.price_change_15,
      f.price_change_60,
      f.distance_to_high,
      f.distance_to_low,
      mc.imoex_change
    FROM candles c
    JOIN features f ON f.candle_id = c.id
    LEFT JOIN LATERAL (
      SELECT imoex_change
      FROM market_context mc2
      WHERE mc2.timestamp <= c.timestamp
      ORDER BY mc2.timestamp DESC
      LIMIT 1
    ) mc ON true
    WHERE c.ticker = ${ticker}
      AND c.timeframe = '10m'
      AND c.source = 'moex_iss'
      AND c.timestamp >= ${since.toISOString()}
    ORDER BY c.timestamp
  `);

  return rows.rows.map((r) => ({
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
    priceChange1: r.price_change_1 !== null ? Number(r.price_change_1) : null,
    priceChange5: r.price_change_5 !== null ? Number(r.price_change_5) : null,
    priceChange15: r.price_change_15 !== null ? Number(r.price_change_15) : null,
    priceChange60: r.price_change_60 !== null ? Number(r.price_change_60) : null,
    distanceToHigh: r.distance_to_high !== null ? Number(r.distance_to_high) : null,
    distanceToLow: r.distance_to_low !== null ? Number(r.distance_to_low) : null,
    imoexChange: r.imoex_change !== null ? Number(r.imoex_change) : null,
  }));
}

// ── Labeling ──────────────────────────────────────────────────────────────────

type LabelRow = {
  targetHit: boolean;
  stopHit: boolean;
  returnPct: number; // actual return at horizon (close of last bar)
  mfe: number;       // max favourable excursion
  mae: number;       // max adverse excursion
};

function labelBars(
  rows: FeatureRow[],
  targetPct: number,
  horizonBars: number,
): LabelRow[] {
  const n = rows.length;
  const labels: LabelRow[] = [];
  for (let i = 0; i < n; i++) {
    const entry = rows[i].close;
    const targetPrice = entry * (1 + targetPct / 100);
    const stopPrice = entry * (1 - targetPct / 100);
    let targetHit = false;
    let stopHit = false;
    let mfe = 0;
    let mae = 0;
    let targetBarIdx = -1;
    let stopBarIdx = -1;
    const end = Math.min(i + horizonBars, n - 1);
    for (let j = i + 1; j <= end; j++) {
      const high = rows[j].high;
      const low = rows[j].low;
      const fav = (high - entry) / entry * 100;
      const adv = (entry - low) / entry * 100;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
      if (!targetHit && high >= targetPrice) {
        targetHit = true;
        targetBarIdx = j;
      }
      if (!stopHit && low <= stopPrice) {
        stopHit = true;
        stopBarIdx = j;
      }
    }
    // Conservative: if stop hit first (or same bar), it's a loss
    if (stopHit && targetHit && stopBarIdx <= targetBarIdx) {
      targetHit = false;
    }
    const lastClose = end > i ? rows[end].close : entry;
    const returnPct = (lastClose - entry) / entry * 100 - COST_PCT;
    labels.push({ targetHit, stopHit, returnPct, mfe, mae });
  }
  return labels;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

type SetupStats = {
  occurrences: number;
  winRate: number;
  avgReturn: number;
  medianReturn: number;
  profitFactor: number;
  maxDrawdown: number;
  avgMae: number;
  avgMfe: number;
};

function computeStats(
  labels: LabelRow[],
  indices: number[],
): SetupStats | null {
  const matching = indices.map((i) => labels[i]);
  const n = matching.length;
  if (n < MIN_OCC) return null;
  const wins = matching.filter((l) => l.targetHit).length;
  const winRate = wins / n;
  const returns = matching.map((l) => l.targetHit ? l.mfe - COST_PCT : -l.mae - COST_PCT);
  returns.sort((a, b) => a - b);
  const avgReturn = returns.reduce((s, v) => s + v, 0) / n;
  const medianReturn = n % 2 === 0
    ? (returns[n / 2 - 1] + returns[n / 2]) / 2
    : returns[Math.floor(n / 2)];
  const grossWin = matching.filter((l) => l.targetHit).reduce((s, l) => s + l.mfe, 0);
  const grossLoss = matching.filter((l) => !l.targetHit).reduce((s, l) => s + l.mae, 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  // Equity drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const avgMae = matching.reduce((s, l) => s + l.mae, 0) / n;
  const avgMfe = matching.reduce((s, l) => s + l.mfe, 0) / n;
  return { occurrences: n, winRate, avgReturn, medianReturn, profitFactor, maxDrawdown: maxDD, avgMae, avgMfe };
}

function confidence(train: SetupStats, val: SetupStats | null, test: SetupStats | null): number {
  // 0–100 score
  const wrScore = Math.min(100, Math.max(0, (train.winRate - 0.5) / 0.25 * 50));
  const sampleScore = Math.min(20, Math.log(train.occurrences / MIN_OCC) * 10);
  const consistencyScore = val && test
    ? Math.min(20, (1 - Math.abs(train.winRate - test.winRate) / train.winRate) * 20)
    : 0;
  const pfScore = Math.min(10, (Math.min(train.profitFactor, 4) - 1) / 3 * 10);
  return Math.round(wrScore + sampleScore + consistencyScore + pfScore);
}

// ── Combination search ────────────────────────────────────────────────────────

type FoundSetup = {
  conditions: { feature: string; label: string }[];
  targetPct: number;
  horizonBars: number;
  trainStats: SetupStats;
  valStats: SetupStats | null;
  testStats: SetupStats | null;
  conf: number;
};

function buildConditionMatrix(rows: FeatureRow[]): boolean[][] {
  return CONDITIONS.map((cond) => rows.map((r) => cond.test(r)));
}

function searchSetups(
  rows: FeatureRow[],
  labels: LabelRow[],
  targetPct: number,
  horizonBars: number,
): FoundSetup[] {
  const n = rows.length;
  const trainEnd = Math.floor(n * 0.70);
  const valEnd = Math.floor(n * 0.85);
  const trainIdx = Array.from({ length: trainEnd }, (_, i) => i);
  const valIdx = Array.from({ length: valEnd - trainEnd }, (_, i) => i + trainEnd);
  const testIdx = Array.from({ length: n - valEnd }, (_, i) => i + valEnd);

  if (trainIdx.length < MIN_OCC * 3) return [];

  const matrix = buildConditionMatrix(rows);
  const found: FoundSetup[] = [];

  // ── Single conditions ──
  const singleWinRates: { ci: number; wr: number }[] = [];
  for (let ci = 0; ci < N_CONDITIONS; ci++) {
    const trainMatch = trainIdx.filter((i) => matrix[ci][i]);
    if (trainMatch.length < MIN_OCC) continue;
    const winRate = trainMatch.filter((i) => labels[i].targetHit).length / trainMatch.length;
    singleWinRates.push({ ci, wr: winRate });
  }

  // Top 15 conditions by win rate for pair/triple search
  const top15 = singleWinRates
    .filter((c) => c.wr >= MIN_WR - 0.05)
    .sort((a, b) => b.wr - a.wr)
    .slice(0, 15)
    .map((c) => c.ci);

  // ── Pairs ──
  const candidatePairs: [number, number][] = [];
  for (let ai = 0; ai < top15.length; ai++) {
    for (let bi = ai + 1; bi < top15.length; bi++) {
      candidatePairs.push([top15[ai], top15[bi]]);
    }
  }

  // ── Evaluate single + pairs ──
  const allCandidates: { condIdxs: number[]; trainWR: number }[] = [];

  // Singles
  for (const { ci, wr } of singleWinRates) {
    if (wr >= MIN_WR) allCandidates.push({ condIdxs: [ci], trainWR: wr });
  }

  // Pairs
  for (const [a, b] of candidatePairs) {
    const trainMatch = trainIdx.filter((i) => matrix[a][i] && matrix[b][i]);
    if (trainMatch.length < MIN_OCC) continue;
    const wr = trainMatch.filter((i) => labels[i].targetHit).length / trainMatch.length;
    if (wr >= MIN_WR) allCandidates.push({ condIdxs: [a, b], trainWR: wr });
  }

  // Sort by win rate descending
  allCandidates.sort((a, b) => b.trainWR - a.trainWR);

  for (const { condIdxs } of allCandidates.slice(0, 20)) {
    const trainMatch = trainIdx.filter((i) => condIdxs.every((ci) => matrix[ci][i]));
    const trainStats = computeStats(labels, trainMatch);
    if (!trainStats || trainStats.winRate < MIN_WR) continue;

    const valMatch = valIdx.filter((i) => condIdxs.every((ci) => matrix[ci][i]));
    const valStats = computeStats(labels, valMatch);
    // Val threshold is relaxed to account for fewer samples
    if (!valStats || valStats.winRate < MIN_WR - 0.07) continue;

    const testMatch = testIdx.filter((i) => condIdxs.every((ci) => matrix[ci][i]));
    const testStats = computeStats(labels, testMatch);

    const conds = condIdxs.map((ci) => ({
      feature: CONDITIONS[ci].feature,
      label: CONDITIONS[ci].label,
    }));
    const conf = confidence(trainStats, valStats, testStats);

    found.push({ conditions: conds, targetPct, horizonBars, trainStats, valStats, testStats, conf });
  }

  return found;
}

// ── DB persistence ────────────────────────────────────────────────────────────

async function saveSetups(ticker: string, setups: FoundSetup[]): Promise<void> {
  if (setups.length === 0) return;
  // Deactivate old setups for this ticker
  await db.execute(sql`
    UPDATE stock_setups SET is_active = false WHERE ticker = ${ticker}
  `);

  for (let idx = 0; idx < setups.length; idx++) {
    const s = setups[idx];
    const ts = s.testStats;
    await db
      .insert(stockSetups)
      .values({
        ticker,
        setupIndex: idx + 1,
        direction: "LONG",
        conditions: s.conditions,
        targetPercent: s.targetPct,
        horizonBars: s.horizonBars,
        isActive: true,
        trainOccurrences: s.trainStats.occurrences,
        trainWinRate: s.trainStats.winRate,
        valOccurrences: s.valStats?.occurrences ?? null,
        valWinRate: s.valStats?.winRate ?? null,
        testOccurrences: ts?.occurrences ?? null,
        testWinRate: ts?.winRate ?? null,
        testAvgReturn: ts?.avgReturn ?? null,
        testMedianReturn: ts?.medianReturn ?? null,
        testProfitFactor: ts?.profitFactor ?? null,
        testMaxDrawdown: ts?.maxDrawdown ?? null,
        testAvgMae: ts?.avgMae ?? null,
        testAvgMfe: ts?.avgMfe ?? null,
        confidence: s.conf,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          stockSetups.ticker,
          stockSetups.setupIndex,
          stockSetups.direction,
          stockSetups.targetPercent,
        ],
        set: {
          conditions: sql`excluded.conditions`,
          horizonBars: sql`excluded.horizon_bars`,
          isActive: sql`true`,
          trainOccurrences: sql`excluded.train_occurrences`,
          trainWinRate: sql`excluded.train_win_rate`,
          valOccurrences: sql`excluded.val_occurrences`,
          valWinRate: sql`excluded.val_win_rate`,
          testOccurrences: sql`excluded.test_occurrences`,
          testWinRate: sql`excluded.test_win_rate`,
          testAvgReturn: sql`excluded.test_avg_return`,
          testMedianReturn: sql`excluded.test_median_return`,
          testProfitFactor: sql`excluded.test_profit_factor`,
          testMaxDrawdown: sql`excluded.test_max_drawdown`,
          testAvgMae: sql`excluded.test_avg_mae`,
          testAvgMfe: sql`excluded.test_avg_mfe`,
          confidence: sql`excluded.confidence`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function processTickerSetups(ticker: string): Promise<number> {
  const rows = await loadTickerData(ticker);
  if (rows.length < 200) {
    process.stderr.write(`${ticker}: недостаточно данных (${rows.length} баров)\n`);
    return 0;
  }

  const allSetups: FoundSetup[] = [];
  const targets = ONLY_TARGET ? [ONLY_TARGET] : TARGETS;

  for (const targetPct of targets) {
    for (const { bars } of HORIZONS) {
      const labels = labelBars(rows, targetPct, bars);
      const setups = searchSetups(rows, labels, targetPct, bars);
      allSetups.push(...setups);
    }
  }

  // Deduplicate: keep only unique condition sets, highest confidence first
  const seen = new Set<string>();
  const unique = allSetups
    .sort((a, b) => b.conf - a.conf)
    .filter((s) => {
      const key = s.conditions.map((c) => c.feature).sort().join("+") + `@${s.targetPct}@${s.horizonBars}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10); // не более 10 сетапов на акцию

  await saveSetups(ticker, unique);
  process.stdout.write(
    `${ticker}: ${rows.length} баров → ${unique.length} сетапов` +
    (unique.length > 0 ? ` (конфиденс: ${unique.map((s) => s.conf).join(", ")})` : "") +
    "\n",
  );
  return unique.length;
}

async function main() {
  const allTickers = await loadTickers();
  const tickers = ONLY_TICKER ? [ONLY_TICKER] : allTickers;
  process.stdout.write(`Per-Stock Setup Scanner: ${tickers.length} тикеров\n`);

  let totalSetups = 0;
  let errors = 0;
  for (const ticker of tickers) {
    try {
      totalSetups += await processTickerSetups(ticker);
    } catch (err) {
      process.stderr.write(`${ticker}: ошибка — ${String(err)}\n`);
      errors++;
    }
  }
  process.stdout.write(
    `\nГотово. Тикеров: ${tickers.length}; новых сетапов: ${totalSetups}; ошибок: ${errors}\n`,
  );
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
