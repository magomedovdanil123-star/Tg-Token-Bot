import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  candles,
  db,
  features,
  marketContext,
  pool,
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
};

type LatestMarket = {
  timestamp: Date;
  imoexPrice: number | null;
  imoexChange: number | null;
};

type TopRow = LatestFeature & { ticker: string };
type SignalDirection = "BUY" | "SELL" | "HOLD";

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
    .where(eq(features.ticker, ticker))
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
    SELECT DISTINCT ON (f.ticker)
      f.ticker,
      f.timestamp,
      c.close,
      f.ema_20 AS "ema20",
      f.ema_50 AS "ema50",
      f.rsi,
      f.macd_hist AS "macdHist",
      f.relative_volume AS "relativeVolume",
      f.atr
    FROM features f
    INNER JOIN candles c
      ON c.ticker = f.ticker
      AND c.timeframe = ${TIMEFRAME}
      AND c.timestamp = f.timestamp
    WHERE f.ticker <> 'IMOEX'
    ORDER BY f.ticker, f.timestamp DESC
  `);
  return result.rows as unknown as TopRow[];
}

function helpText() {
  return [
    "INVEST AI Research Engine",
    "",
    "Команды:",
    "/signal SBER — сигнал по тикеру",
    "/market — состояние IMOEX",
    "/top — лучшие текущие сигналы",
    "/help — справка",
    "",
    "Данные: исторические свечи MOEX и рассчитанные признаки.",
  ].join("\n");
}

async function signalText(ticker: string) {
  const feature = await getLatestFeature(ticker);
  if (!feature) {
    return `Не нашёл данные по ${ticker}.\nПроверьте тикер, например: /signal SBER`;
  }

  const analysis = scoreFeature(feature);
  const stop =
    analysis.direction === "SELL"
      ? feature.close * 1.01
      : feature.close * 0.99;
  const target =
    analysis.direction === "SELL"
      ? feature.close * 0.98
      : feature.close * 1.02;

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
    `Стоп: ${formatNumber(stop)}`,
    `Цель: ${formatNumber(target)}`,
    "Горизонт: 60 минут",
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
  const ranked = rows
    .map((row) => ({ row, analysis: scoreFeature(row) }))
    .filter(({ analysis }) => analysis.direction !== "HOLD")
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
  const [command, argument] = text.trim().split(/\s+/, 2);
  const normalizedCommand = command.toLowerCase().split("@", 1)[0];

  if (normalizedCommand === "/start" || normalizedCommand === "/help") {
    return helpText();
  }
  if (normalizedCommand === "/market") {
    return marketText();
  }
  if (normalizedCommand === "/top") {
    return topText();
  }
  if (normalizedCommand === "/signal") {
    const ticker = argument?.toUpperCase().replace(/[^A-Z0-9_]/g, "");
    return ticker ? signalText(ticker) : "Укажите тикер: /signal SBER";
  }
  if (text.startsWith("/")) {
    return "Неизвестная команда. Используйте /help.";
  }
  return undefined;
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
          { command: "market", description: "Состояние рынка" },
          { command: "top", description: "Лучшие сигналы" },
          { command: "help", description: "Справка" },
        ]),
      );
      logger.info({ username: me.username ?? "unknown" }, "Telegram bot connected");

      while (running) {
        const updates = await client.getUpdates(offset, controller.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text) continue;
          const response = await handleMessage(message.chat.id, message.text);
          if (response) {
            await client.sendMessage(message.chat.id, response);
          }
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