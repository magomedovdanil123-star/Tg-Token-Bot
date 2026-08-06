---
name: Hidden signal learning
description: The background learner evaluates paper signals independently against fixed ±1.5% control levels.
---

The learning layer is deliberately separate from live signal rules and Telegram UI. Every newly recorded paper signal carries its entry context, strategy metadata, and a fixed-control evaluation state; a background worker later records which of +1.5% or -1.5% came first, same-candle ambiguity conservatively favors the stop, and operational REDUCE/EXIT outcomes remain separate.

**Why:** Signal quality and position-management exits must be analyzed without allowing early structural exits or adaptive ATR targets to distort the common control group.

**How to apply:** Do not add Telegram buttons or let this evaluator change production filters automatically. Use its accumulated results for offline analysis before proposing strategy changes.