# Invest AI data platform

Stores MOEX market candles, technical indicators, market context, and research results in PostgreSQL for later analysis.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts run download-moex` — load two years of 10-minute MOEX data for the top 100 shares
- `pnpm --filter @workspace/scripts run download-context` — load daily IMOEX, RTSI, USD/RUB, EUR/RUB, and CNY/RUB context rows
- `pnpm --filter @workspace/scripts run refresh-features` — recalculate and update all stored feature rows after schema/indicator changes
- `pnpm --filter @workspace/scripts run refresh-features -- --features-start=45 --features-limit=20` — refresh a bounded ticker range
- `pnpm --filter @workspace/scripts run download-moex -- --years=1 --max-tickers=10` — run a smaller import
- `pnpm --filter @workspace/scripts run download-moex -- --years=2 --start-rank=10 --max-tickers=10 --skip-context=true` — resume a chunk without reloading IMOEX
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/db/src/schema/index.ts` — PostgreSQL schema for tickers, candles, features, market context, patterns, and import runs.
- `scripts/src/download-moex-data.ts` — paginated MOEX ISS importer and technical indicator calculation.
- `artifacts/api-server` — existing API server; Telegram bot code is intentionally not part of this data setup.

## Architecture decisions

- Candles and features use a unique `(ticker, timeframe, timestamp)` key so rerunning imports is safe.
- MOEX data is fetched through the public ISS API using native Node fetch; no Telegram credentials are required.
- Import runs are recorded in `download_runs` so long imports have an auditable status and error summary.

## Product

- PostgreSQL storage for ranked MOEX tickers and 10-minute candles.
- Derived trend, momentum, volatility, candle, volume, Bollinger, MACD, RSI, ATR, VWAP, OBV, MFI, CCI, and Williams %R features.
- Separate market context, macro, pattern, signal, strategy, and backtest tables for the research engine.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
