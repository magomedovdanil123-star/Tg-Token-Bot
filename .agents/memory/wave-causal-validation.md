---
name: Wave causal validation
description: Validation rule for Elliott/ABC wave backtests.
---

Wave pivots must be accumulated candle by candle and only become usable after their confirmation candles. A full-series pivot list can replace earlier pivots with more extreme future points and produce an invalidly high historical win rate.

**Why:** The initial wave backtest showed 65–70% pockets that disappeared when pivot formation was made causal; tiny targets could also inflate win rate while remaining negative after round-trip costs.

**How to apply:** Treat win rate, expectancy, profit factor, and bank simulations as valid only after causal pivot construction, conservative same-candle TP/SL handling, costs, and a time-separated test period.