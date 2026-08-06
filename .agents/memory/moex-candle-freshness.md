---
name: MOEX candle freshness
description: MOEX candle timestamps identify interval starts, so freshness must be checked against the candle close.
---

MOEX 1m and 1h timestamps mark the beginning of each candle. Freshness checks must add the timeframe duration before comparing with now; structure may use only closed aggregate bars, while execution can use the newest 1m close.

**Why:** Treating a candle start as its close made normal current 1h data appear stale by one full hour and excluded stocks from live Smart Money scans.

**How to apply:** Use closed 15m/HTF bars for BOS, CHoCH, trend, and R:R structure; use the latest valid 1m close for the actionable entry price.