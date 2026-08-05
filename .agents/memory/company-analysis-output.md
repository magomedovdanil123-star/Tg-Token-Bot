---
name: Company analysis output
description: Product rule for the Telegram company-analysis flow
---

Company analysis is a ticker-scoped view of the existing Smart Money scanner, not a separate technical-analysis report. It must use the same candidate formatting and must send no message when the selected ticker has no valid entry.

**Why:** The user wants selecting a company to behave exactly like Smart Money, without extra timeframe indicators or rejection diagnostics.

**How to apply:** Keep company selection routed through the established SMC preparation, scan, candidate formatting, and paper-recording path. Do not add RSI/EMA/timeframe summaries or “no signal” messages to this flow.