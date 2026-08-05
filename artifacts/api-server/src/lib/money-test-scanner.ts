import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  scanSmartMoney,
  type SmartMoneyCandidate,
  type SmartMoneyScan,
} from "./smart-money-scanner";

export type MoneyTestDirection = "BUY" | "SELL" | "NEUTRAL";

export type MoneyTestMarket = {
  direction: MoneyTestDirection;
  advancers: number;
  decliners: number;
  unchanged: number;
  breadthPercent: number;
  inTradeWindow: boolean;
  sessionLabel: string;
  timestamp: Date;
};

export type MoneyTestScan = {
  generatedAt: Date;
  base: SmartMoneyScan;
  candidates: SmartMoneyCandidate[];
  market: MoneyTestMarket;
  rejected: Array<{ ticker: string; reasons: string[] }>;
};

function moscowParts(timestamp: Date) {
  const values = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const hour = Number(values.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(values.find((part) => part.type === "minute")?.value ?? 0);
  return { hour, minute };
}

function sessionFor(timestamp: Date) {
  const { hour, minute } = moscowParts(timestamp);
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 10 * 60 + 15) return { label: "до активной фазы", inTradeWindow: false };
  if (totalMinutes >= 13 * 60 && totalMinutes < 14 * 60) {
    return { label: "обеденная пауза", inTradeWindow: false };
  }
  if (totalMinutes > 18 * 60 + 30) return { label: "после активной фазы", inTradeWindow: false };
  return {
    label: totalMinutes < 11 * 60 ? "открытие и первый импульс" : "основная сессия",
    inTradeWindow: true,
  };
}

async function analyzeMarket(timestamp: Date): Promise<MoneyTestMarket> {
  const result = await db.execute(sql`
    SELECT ticker, close, timestamp
    FROM (
      SELECT
        ticker,
        close,
        timestamp,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS row_number
      FROM candles
      WHERE timeframe = '1m'
        AND ticker IN (SELECT secid FROM moex_tickers WHERE is_active = true)
    ) latest
    WHERE row_number <= 2
    ORDER BY ticker, timestamp DESC
  `);
  const byTicker = new Map<string, Array<{ close: number; timestamp: Date }>>();
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const ticker = String(row.ticker);
    const close = Number(row.close);
    const candleTimestamp =
      row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
    if (!Number.isFinite(close) || !Number.isFinite(candleTimestamp.getTime())) continue;
    const values = byTicker.get(ticker) ?? [];
    values.push({ close, timestamp: candleTimestamp });
    byTicker.set(ticker, values);
  }
  let advancers = 0;
  let decliners = 0;
  let unchanged = 0;
  for (const values of byTicker.values()) {
    const [latest, previous] = values;
    if (!latest || !previous) continue;
    const change = latest.close - previous.close;
    if (change > 0) advancers += 1;
    else if (change < 0) decliners += 1;
    else unchanged += 1;
  }
  const total = advancers + decliners + unchanged;
  const breadthPercent = total ? ((advancers - decliners) / total) * 100 : 0;
  const direction =
    breadthPercent >= 20
      ? "BUY"
      : breadthPercent <= -20
        ? "SELL"
        : "NEUTRAL";
  const session = sessionFor(timestamp);
  return {
    direction,
    advancers,
    decliners,
    unchanged,
    breadthPercent,
    inTradeWindow: session.inTradeWindow,
    sessionLabel: session.label,
    timestamp,
  };
}

async function liquidityByTicker() {
  const result = await db.execute(sql`
    SELECT ticker,
      AVG(volume) FILTER (
        WHERE timestamp >= NOW() - INTERVAL '20 minutes'
      ) AS recent_volume,
      AVG(volume) FILTER (
        WHERE timestamp < NOW() - INTERVAL '20 minutes'
          AND timestamp >= NOW() - INTERVAL '4 hours'
      ) AS baseline_volume
    FROM candles
    WHERE timeframe = '1m'
      AND ticker IN (SELECT secid FROM moex_tickers WHERE is_active = true)
      AND timestamp >= NOW() - INTERVAL '4 hours'
    GROUP BY ticker
  `);
  return new Map(
    result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const recent = Number(row.recent_volume);
      const baseline = Number(row.baseline_volume);
      return [
        String(row.ticker),
        Number.isFinite(recent) && Number.isFinite(baseline) && baseline > 0
          ? recent / baseline
          : null,
      ] as const;
    }),
  );
}

export async function scanMoneyTest(): Promise<MoneyTestScan> {
  const base = await scanSmartMoney(undefined, {
    universe: "imoex",
    source: "money-test",
  });
  const market = await analyzeMarket(base.generatedAt);
  const liquidity = await liquidityByTicker();
  const rejected: Array<{ ticker: string; reasons: string[] }> = [];
  const candidates = base.candidates.filter((candidate) => {
    const reasons: string[] = [];
    if (!market.inTradeWindow) {
      reasons.push(`Вне активного торгового окна: ${market.sessionLabel}.`);
    }
    if (
      market.direction !== "NEUTRAL" &&
      candidate.direction !== market.direction
    ) {
      reasons.push(
        `Направление против ширины рынка: ${market.direction} при breadth ${market.breadthPercent.toFixed(1)}%.`,
      );
    }
    if (
      !candidate.retestConfirmed &&
      !candidate.orderBlock &&
      !candidate.fairValueGap
    ) {
      reasons.push("Нет качественной точки входа возле OB/FVG или подтверждённого ретеста.");
    }
    if (!candidate.volumeConfirmed) {
      reasons.push("Нет подтверждения объёмом.");
    }
    const liquidityRatio = liquidity.get(candidate.ticker);
    if (liquidityRatio !== null && liquidityRatio !== undefined && liquidityRatio < 0.65) {
      reasons.push(`Текущая ликвидность ${liquidityRatio.toFixed(2)}x ниже базовой.`);
    }
    if (reasons.length) {
      rejected.push({ ticker: candidate.ticker, reasons });
      return false;
    }
    return true;
  });
  return {
    generatedAt: base.generatedAt,
    base,
    candidates,
    market,
    rejected,
  };
}