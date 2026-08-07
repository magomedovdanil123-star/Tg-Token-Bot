---
name: Replit/MTS event discovery
description: Results and acceptance rule for the independent historical Replit/MTS strategy research.
---

The historical event-driven 1H discovery uses only closed candles, a 12-bar per-ticker cooldown, conservative same-bar TP/SL handling, and a 0.1% round-trip cost. IMOEX regime is derived causally from the closed 1H index candles. Level research found no eligible bounce setup; the only positive train/test family was a low-sample SHORT after a 0.5% break below a repeatedly tested support, so it remains research-only. The live experimental Replit path now requires a 0.5% adverse move followed by a closed 15m directional reclaim with body and volume confirmation before entering at fresh 1m price.

**Why:** Break-support candidates had positive expectancy in both splits, but only 15–17 test trades and no validated bounce edge; this is insufficient evidence for Telegram activation. A causal retest simulation on recent production signals improved the comparable Replit sample while reducing trade count, so the filter is suitable for paper observation but still needs forward validation.

**How to apply:** Keep level-break research separate from Smart Money. Treat live Replit retest/reclaim records as a new experimental cohort, measure them separately from the old immediate-entry cohort, and require forward results across more periods/tickers before calling it validated. Do not change Smart Money to match this experiment.