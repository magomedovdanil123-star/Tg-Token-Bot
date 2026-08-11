---
name: Smart Money backtest
description: Methodology for historical SMC performance checks
---

Historical Smart Money checks must run outside the live scanner and reproduce its existing candidate rules without changing production filtering. Portfolio reporting uses fixed equal allocations, a maximum of five simultaneous positions, round-trip transaction costs, and conservative same-candle TP/SL handling.

**Why:** The user wants performance evidence for the exact signals that could reach Telegram, while keeping the approved Smart Money behavior unchanged.

**How to apply:** Keep the backtest as a separate runner. Report the date window, eligible/evaluable/portfolio trades, win rate, outcome breakdown, P&L, final balance, and assumptions; do not turn backtest adjustments into live strategy changes. For large MOEX windows, stream one ticker at a time instead of loading every candle into one process; never label a result as six- or twelve-month performance unless the execution-timeframe data covers that window.

**Why:** Timeweb has limited memory and the MOEX minute history is materially shorter than its hourly history for most tickers, so an all-history in-memory runner can be killed and a long-period result can be falsely implied from incomplete data.