---
name: MOEX importer
description: Durable MOEX ISS constraints and data-universe decisions.
---

MOEX ISS does not return candles for the requested 15-minute interval in this project; its supported intraday interval is 10 minutes, so stored candle and pattern defaults use `10m`.

**Why:** Requests for 15-minute candles returned empty datasets even for liquid securities, while interval 10 returned real history.

**How to apply:** Keep the importer and schema aligned on `10m`, and treat the requested “top shares” universe as `SECTYPE=1` so ETF/fund rows are not mixed into equities.