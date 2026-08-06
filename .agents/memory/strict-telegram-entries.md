---
name: Strict Telegram entries
description: Quality gates and early-exit handling for live Smart Money Telegram alerts.
---

The experimental Money Test flow may use strict entry gates: high score, confirmed retest, 4H/1D alignment, additional OB/FVG/liquidity confirmation, and a net reward/risk buffer above the basic minimum. Ordinary Smart Money entries keep the baseline scanner selection. Ordinary Smart Money has no separate operational REDUCE/EXIT notifier; Money Test and commodity monitoring keep their own grace periods.

**Why:** The user wants strict filtering isolated to Money Test so ordinary Smart Money does not become too rare, while avoiding premature operational exit recommendations.

**How to apply:** Gate strict scanner conditions on the `money-test` source. Do not add ordinary Smart Money structural/volume exit notifications unless explicitly requested; keep hard price targets and stops separate from operational warnings.