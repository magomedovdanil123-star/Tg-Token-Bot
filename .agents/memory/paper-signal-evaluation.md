---
name: Paper signal evaluation
description: Rules for interpreting the bot's simulated signal performance.
---

Paper-trading results must include round-trip commission and slippage, and a candle that touches both target and stop must be counted as a stop-loss outcome.

**Why:** Close-only historical checks can overstate performance; same-candle OHLC data cannot establish which intrabar level was reached first.

**How to apply:** Keep this policy for future accuracy reports and any later backtest or execution simulation.