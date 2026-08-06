---
name: MOEX importer
description: Durable MOEX ISS constraints and data-universe decisions.
---

MOEX ISS behavior in this project is interval-specific: 1-minute and 10-minute candles return real data, while 5-minute and 15-minute requests can return empty datasets. Keep `1m` fast candles isolated in `candles` and calculate their indicators directly; keep the research layer on `10m`.

**Why:** The public ISS endpoint returned 90k real 1-minute candles for the IMOEX universe, but returned empty 5-minute responses even for liquid securities. Mixing fast candles into the shared `features` table would overwrite the 10-minute research feature stream because its uniqueness is ticker plus timestamp.

**How to apply:** Use `timeframe=1m` for intraday imports and direct calculations, `10m` for research features, and do not fabricate or resample 5-minute data without a separate explicit policy. Treat the requested “top shares” universe as `SECTYPE=1` so ETF/fund rows are not mixed into equities. For the Smart Money expansion, use MOEX's official `LISTLEVEL=2` share list only; keep level 3, ETFs, and closed-end funds out, and preserve these supplemental tickers when synchronizing the IMOEX active universe.