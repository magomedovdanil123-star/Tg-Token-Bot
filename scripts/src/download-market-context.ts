import { and, eq } from "drizzle-orm";
import {
  db,
  marketInstruments,
  marketObservations,
  pool,
} from "@workspace/db";

type Block = { columns?: string[]; data?: unknown[][] };
type Response = Record<string, Block | undefined>;
type InstrumentSpec = {
  code: string;
  name: string;
  category: string;
  engine: string;
  market: string;
  board: string;
  secid: string;
  currency?: string;
};

const API_ROOT = "https://iss.moex.com/iss";
const PAGE_SIZE = 500;
const instruments: InstrumentSpec[] = [
  {
    code: "IMOEX",
    name: "Индекс МосБиржи",
    category: "index",
    engine: "stock",
    market: "index",
    board: "SNDX",
    secid: "IMOEX",
    currency: "RUB",
  },
  {
    code: "RTSI",
    name: "Индекс РТС",
    category: "index",
    engine: "stock",
    market: "index",
    board: "SNDX",
    secid: "RTSI",
    currency: "USD",
  },
  {
    code: "USD_RUB",
    name: "USD/RUB",
    category: "currency",
    engine: "currency",
    market: "selt",
    board: "CETS",
    secid: "USD000UTSTOM",
    currency: "RUB",
  },
  {
    code: "EUR_RUB",
    name: "EUR/RUB",
    category: "currency",
    engine: "currency",
    market: "selt",
    board: "CETS",
    secid: "EUR_RUB__TOM",
    currency: "RUB",
  },
  {
    code: "CNY_RUB",
    name: "CNY/RUB",
    category: "currency",
    engine: "currency",
    market: "selt",
    board: "CETS",
    secid: "CNYRUB_TOM",
    currency: "RUB",
  },
];

function rows(response: Response, key: string) {
  const block = response[key];
  if (!block?.columns || !block.data) return [];
  return block.data.map((row) =>
    Object.fromEntries(
      block.columns!.map((column, index) => [column.toLowerCase(), row[index]]),
    ),
  );
}

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMoexTimestamp(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return new Date(Number.NaN);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(?:\.\d+)?)?$/.test(text)) {
    return new Date(`${text.replace(" ", "T")}+03:00`);
  }
  return new Date(text);
}

async function fetchJson(path: string, params: Record<string, string | number>) {
  const url = new URL(`${API_ROOT}${path}`);
  url.searchParams.set("iss.meta", "off");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "InvestAI/1.0" },
  });
  if (!response.ok) throw new Error(`MOEX HTTP ${response.status}: ${url.pathname}`);
  return (await response.json()) as Response;
}

async function loadObservations(instrument: InstrumentSpec, from: string, till: string) {
  const output: {
    timestamp: Date;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    value?: number;
    changePercent?: number;
  }[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const response = await fetchJson(
      `/engines/${instrument.engine}/markets/${instrument.market}/boards/${instrument.board}/securities/${instrument.secid}/candles.json`,
      { interval: 24, from, till, start, limit: PAGE_SIZE },
    );
    const block = rows(response, "candles");
    for (const row of block) {
      const timestamp = parseMoexTimestamp(row.begin ?? row.end);
      const open = numberValue(row.open);
      const close = numberValue(row.close);
      if (Number.isNaN(timestamp.getTime()) || close === undefined) continue;
      output.push({
        timestamp,
        open,
        high: numberValue(row.high),
        low: numberValue(row.low),
        close,
        volume: numberValue(row.volume),
        value: numberValue(row.value),
        changePercent: open ? ((close - open) / open) * 100 : undefined,
      });
    }
    if (block.length < PAGE_SIZE) break;
  }
  return output;
}

async function main() {
  const till = new Date();
  const fromDate = new Date(till);
  fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 2);
  const from = fromDate.toISOString().slice(0, 10);
  const end = till.toISOString().slice(0, 10);

  for (const instrument of instruments) {
    const savedInstrument = await db
      .insert(marketInstruments)
      .values(instrument)
      .onConflictDoUpdate({
        target: marketInstruments.code,
        set: {
          name: instrument.name,
          engine: instrument.engine,
          market: instrument.market,
          board: instrument.board,
          secid: instrument.secid,
          currency: instrument.currency,
          isActive: true,
        },
      })
      .returning({ id: marketInstruments.id });
    const instrumentId = savedInstrument[0]?.id;
    if (!instrumentId) throw new Error(`Unable to save ${instrument.code}`);

    const observations = await loadObservations(instrument, from, end);
    for (let index = 0; index < observations.length; index += 500) {
      await db
        .insert(marketObservations)
        .values(
          observations.slice(index, index + 500).map((observation) => ({
            instrumentId,
            timeframe: "1d",
            ...observation,
          })),
        )
        .onConflictDoNothing({
          target: [
            marketObservations.instrumentId,
            marketObservations.timeframe,
            marketObservations.timestamp,
          ],
        });
    }
    console.log(`${instrument.code}: ${observations.length} дневных наблюдений`);
  }
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});