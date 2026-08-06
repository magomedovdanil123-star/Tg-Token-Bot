---
name: MOEX timestamp timezone
description: The timezone contract for raw MOEX ISS candle timestamps and production data repair.
---

Raw MOEX ISS candle timestamps can omit the timezone while representing Europe/Moscow local time. They must be parsed with an explicit Moscow offset before storing them in PostgreSQL.

**Why:** production runs in UTC; parsing a raw `YYYY-MM-DD HH:mm:ss` string as UTC shifts candles three hours into the future, making stale higher-timeframe context appear current and allowing look-ahead-like signal timestamps.

**How to apply:** use an explicit `+03:00` parser for intraday MOEX imports and reject future candles during freshness checks. If historical data was written with the wrong interpretation, back it up first and correct only intraday MOEX timestamps; leave daily bars unchanged.