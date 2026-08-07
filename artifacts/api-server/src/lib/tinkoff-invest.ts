/**
 * T-Invest (Tinkoff Investments) REST API client.
 *
 * Uses the gRPC-HTTP gateway at invest-public-api.tinkoff.ru.
 * Provides:
 *  - Instrument FIGI lookup by MOEX ticker (TQBR class)
 *  - Order book (стакан) with bid/ask imbalance
 *
 * TLS note: Replit Node runtime does not trust the T-Invest intermediate
 * certificate chain. We use a custom https.Agent with rejectUnauthorized:false
 * scoped to this module only — all other https connections are unaffected.
 */

import https from "node:https";
import { logger } from "./logger";

const BASE_URL_HOST = "invest-public-api.tinkoff.ru";
const BASE_PATH     = "/rest";

// Custom agent that skips T-Invest's untrusted intermediate cert.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getToken(): string {
  const token = process.env.TINKOFF_INVEST_TOKEN;
  if (!token) throw new Error("TINKOFF_INVEST_TOKEN is not set");
  return token;
}

function httpsPost(
  path: string,
  body: string,
  authToken: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, "utf-8");
    const req = https.request(
      {
        hostname: BASE_URL_HOST,
        path: BASE_PATH + path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": bodyBuf.length,
        },
        agent: insecureAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(`T-Invest ${path} → ${res.statusCode}: ${text.slice(0, 200)}`),
            );
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function tinvest<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const text = await httpsPost(path, JSON.stringify(body), token);
  return JSON.parse(text) as T;
}

// ── FIGI / instrument cache ───────────────────────────────────────────────────

export type InstrumentInfo = { figi: string; uid: string; name: string };
const figiCache = new Map<string, InstrumentInfo | null>(); // null = not found
let cacheBuiltAt = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

async function lookupInstrument(ticker: string): Promise<InstrumentInfo | null> {
  if (figiCache.has(ticker)) return figiCache.get(ticker) ?? null;
  try {
    type GIBResponse = {
      instrument?: { figi: string; uid: string; name?: string };
    };
    const data = await tinvest<GIBResponse>(
      "/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy",
      { idType: "INSTRUMENT_ID_TYPE_TICKER", classCode: "TQBR", id: ticker },
    );
    const inst = data.instrument;
    const info: InstrumentInfo | null = inst
      ? { figi: inst.figi, uid: inst.uid, name: inst.name ?? ticker }
      : null;
    figiCache.set(ticker, info);
    return info;
  } catch (err) {
    logger.warn({ ticker, err }, "T-Invest instrument lookup failed");
    figiCache.set(ticker, null);
    return null;
  }
}

/**
 * Pre-populate the FIGI cache for a list of tickers.
 * No-op if cache was built within the last 6 hours.
 */
export async function prefetchFigis(tickers: string[]): Promise<void> {
  const now = Date.now();
  if (now - cacheBuiltAt < CACHE_TTL_MS) return;
  cacheBuiltAt = now;
  let found = 0;
  for (const ticker of tickers) {
    const info = await lookupInstrument(ticker);
    if (info) found++;
    await new Promise((r) => setTimeout(r, 60)); // 60 ms between calls
  }
  logger.info({ found, total: tickers.length }, "T-Invest FIGI cache built");
}

// ── Order book ────────────────────────────────────────────────────────────────

export type OrderBookLevel = { price: number; quantity: number };

export type OrderBook = {
  ticker: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastPrice: number | null;
  /**
   * bid volume / (bid + ask volume), range 0–1.
   * > 0.5 = buyers dominant, < 0.5 = sellers dominant.
   * null when market is closed (empty book).
   */
  bidImbalance: number | null;
  /** true when at least one bid and one ask level are present */
  marketOpen: boolean;
};

function monoToNum(
  v: { units?: string | number; nano?: string | number } | undefined | null,
): number | null {
  if (!v) return null;
  const units = Number(v.units ?? 0);
  const nano  = Number(v.nano  ?? 0);
  const n = units + nano / 1e9;
  return Number.isFinite(n) ? n : null;
}

function parseLevel(
  raw: Record<string, unknown>,
): OrderBookLevel | null {
  const price    = monoToNum(raw.price as { units?: string; nano?: string } | null);
  const quantity = Number(raw.quantity ?? 0);
  if (price === null || price <= 0 || quantity <= 0) return null;
  return { price, quantity };
}

/**
 * Fetch the order book for a MOEX ticker (TQBR class).
 * Returns null on API failure. Returns a book with empty bids/asks
 * and marketOpen=false when the market is closed.
 */
export async function getOrderBook(
  ticker: string,
  depth = 20,
): Promise<OrderBook | null> {
  const info = await lookupInstrument(ticker);
  if (!info) return null;
  try {
    type OBResponse = {
      bids?: Record<string, unknown>[];
      asks?: Record<string, unknown>[];
      lastPrice?: { units?: string | number; nano?: string | number };
    };
    const data = await tinvest<OBResponse>(
      "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook",
      { figi: info.figi, depth },
    );
    const bids = (data.bids ?? [])
      .map(parseLevel)
      .filter((l): l is OrderBookLevel => l !== null);
    const asks = (data.asks ?? [])
      .map(parseLevel)
      .filter((l): l is OrderBookLevel => l !== null);
    const lastPrice  = monoToNum(data.lastPrice ?? null);
    const bidVol     = bids.reduce((s, l) => s + l.quantity, 0);
    const askVol     = asks.reduce((s, l) => s + l.quantity, 0);
    const total      = bidVol + askVol;
    const bidImbalance = total > 0 ? bidVol / total : null;
    const marketOpen = bids.length > 0 && asks.length > 0;
    return { ticker, bids, asks, lastPrice, bidImbalance, marketOpen };
  } catch (err) {
    logger.warn({ ticker, err }, "T-Invest GetOrderBook failed");
    return null;
  }
}

/**
 * Fetch order books for multiple tickers in parallel (max 8 concurrent).
 */
export async function getOrderBooks(
  tickers: string[],
  depth = 20,
): Promise<Map<string, OrderBook>> {
  const CONCURRENCY = 8;
  const result = new Map<string, OrderBook>();
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch   = tickers.slice(i, i + CONCURRENCY);
    const books   = await Promise.all(batch.map((t) => getOrderBook(t, depth)));
    for (let j = 0; j < batch.length; j++) {
      const book = books[j];
      if (book) result.set(batch[j]!, book);
    }
  }
  return result;
}
