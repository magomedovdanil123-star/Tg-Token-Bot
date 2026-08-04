---
name: Research engine policy
description: Durable rules for factor discovery, validation, and signal consumption.
---

The active signal source is the statistical factor-discovery engine. It must generate factor combinations from stored features, validate them with train/test splits and multiple-testing correction, and persist TP, SL, holding period, and stability metrics before a result becomes active.

**Why:** Legacy hand-authored combinations can look like research output while bypassing out-of-sample validation and exit optimization.

**How to apply:** Keep the Telegram bot filtered to the engine result namespace and preserve dynamic factor-threshold evaluation when adding new factors or retraining the engine.