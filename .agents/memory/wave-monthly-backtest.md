---
name: Wave monthly backtest
description: Capital interpretation for historical Elliott/ABC paper simulations.
---

Monthly wave simulations use a fixed stake per signal and the bot's maximum of five candidates per scan. The result is accumulated P&L across potentially overlapping positions, not the balance path of a single 100,000-ruble account.

**Why:** Applying 100,000 ₽ to every signal can require much more total notional than a 100,000 ₽ bank; open positions at the period end also must not be reported as finalized trades.

**How to apply:** Always report total notional, closed-trade realized P&L, open-position mark-to-market separately, and provide a normalized percentage only as an approximation for a single-bank interpretation.