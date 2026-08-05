---
name: Money Test control group
description: Boundary between the experimental intraday Smart Money fork and the production IMOEX Smart Money section.
---

The Telegram section “Деньги тест” is an experimental control-group fork for intraday IMOEX research. Its paper signals use the separate `money-test` source, separate subscriptions, and separate monitoring; the production `smartmoney` source and its user-facing behavior remain the reference group.

**Why:** New filters such as session timing, market breadth, entry-zone quality, volume, and liquidity need to be evaluated without contaminating the already validated Smart Money statistics or changing its signal behavior.

**How to apply:** Add future experiments only to the Money Test path. Compare count, win rate, expectancy, profit factor, drawdown, and results after costs against the unchanged Smart Money path before promoting any rule.

Money Test scans and position monitoring run about every two minutes. Active paper positions can emit one-time REDUCE or EXIT events for stop/target, structure reversal, market-breadth reversal, or loss of confirmation.