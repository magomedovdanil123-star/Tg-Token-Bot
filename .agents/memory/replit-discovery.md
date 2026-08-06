---
name: Replit/MTS event discovery
description: Results and acceptance rule for the independent historical Replit/MTS strategy research.
---

The event-driven 1H discovery uses only closed candles, a 12-bar per-ticker cooldown, conservative same-bar TP/SL handling, and a 0.1% round-trip cost. IMOEX regime is derived causally from the closed 1H index candles.

**Why:** The first apparent resistance-rejection edge weakened materially after adding the causal IMOEX regime filter and costs. The remaining positive train/test candidates have small expectancy and negative periods, so activating one would risk turning selection noise into Telegram signals.

**How to apply:** Keep the Replit/MTS scanner fail-closed until a setup has positive train and test expectancy after costs, adequate sample size, reasonable confidence bounds, and acceptable stability across independent time segments. Smart Money remains a separate contour.