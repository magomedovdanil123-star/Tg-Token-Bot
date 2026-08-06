---
name: Replit/MTS event discovery
description: Results and acceptance rule for the independent historical Replit/MTS strategy research.
---

The historical event-driven 1H discovery uses only closed candles, a 12-bar per-ticker cooldown, conservative same-bar TP/SL handling, and a 0.1% round-trip cost. IMOEX regime is derived causally from the closed 1H index candles. The live Replit contour is currently an explicitly experimental paper mode: SHORT when at least two of volume >=2x, 3H momentum <=-0.3%, and a bearish candle hold; TP/SL are 1.5%/1.5% with a 24-hour horizon.

**Why:** The statistically screened candidates were too unstable to call production-ready, but the user requested live observation. The experimental rule is therefore enabled only as paper output and must remain clearly labeled as experimental.

**How to apply:** Keep this Replit rule separate from Smart Money, send only paper signals to explicit Replit subscribers, and do not represent its results as validated strategy performance. Promote it only after a fresh train/test review shows adequate stability.