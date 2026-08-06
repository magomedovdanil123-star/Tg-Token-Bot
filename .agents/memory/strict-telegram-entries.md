---
name: Strict Telegram entries
description: Quality gates and early-exit handling for live Smart Money Telegram alerts.
---

Live SMC alerts should favor fewer, stronger setups: require a high score, confirmed retest, 4H/1D alignment, additional OB/FVG/liquidity confirmation, and a net reward/risk buffer above the basic minimum. Operational structural or liquidity deterioration should not trigger an immediate early REDUCE/EXIT during the short post-entry grace period; hard stop-loss and take-profit events remain active immediately.

**Why:** The user reported alerts that required an exit almost immediately after entry and explicitly preferred strict selection over a large signal volume.

**How to apply:** Keep the strict gates in the shared Smart Money scanner so IMOEX, commodities, and experimental flows stay consistent. Keep the grace period limited to non-price structural warnings and evaluate later performance separately from hidden fixed-threshold learning.