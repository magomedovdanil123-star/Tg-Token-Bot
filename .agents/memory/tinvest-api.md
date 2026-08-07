---
name: T-Invest API integration
description: How the Tinkoff Investments REST API is integrated for order book data (стакан).
---

T-Invest gRPC-over-HTTP gateway is at `invest-public-api.tinkoff.ru`.
Token stored in `TINKOFF_INVEST_TOKEN` secret; also added manually to `/opt/invest-ai/.env` on Timeweb.

**Why:** Replit Node runtime does not trust T-Invest's intermediate certificate chain — plain global `fetch` fails with SELF_SIGNED_CERT_IN_CHAIN. The fix uses `node:https` with `new https.Agent({ rejectUnauthorized: false })` scoped only to the T-Invest module (`tinkoff-invest.ts`). Do NOT use undici as a standalone package — it is not installed in this workspace.

**How to apply:** See `artifacts/api-server/src/lib/tinkoff-invest.ts` for all T-Invest calls. During market close (18:50–10:00 Moscow time), bids/asks are empty — `marketOpen: false` — so order book filter is skipped and scanner relies on candle structure alone.

Key endpoints used:
- `GetInstrumentBy` (idType=TICKER, classCode=TQBR) → figi + uid; cached 6 h in module-level Map.
- `GetOrderBook` (figi, depth=20) → bids, asks, lastPrice, bidImbalance = bidVol/(bidVol+askVol).
