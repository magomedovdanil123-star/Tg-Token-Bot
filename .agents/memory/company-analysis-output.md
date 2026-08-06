---
name: Company analysis output
description: Product rule for the Telegram company-analysis flow
---

Company analysis is a ticker-scoped view of the existing Smart Money scanner, not a separate technical-analysis report. The picker must include the complete Smart Money universe, and each selection must return either the same candidate formatting or a concise diagnostic explaining why no valid entry passed.

**Why:** The user wants selecting any added company to behave exactly like Smart Money and no longer receive an empty response when the selected ticker has no valid entry.

**How to apply:** Keep company selection routed through the established SMC preparation, scan, candidate formatting, and paper-recording path. Do not add separate RSI/EMA/timeframe summaries. If no candidate passes, return the ticker's diagnostic reasons and do not record a paper signal.

**Telegram constraint:** Treat `answerCallbackQuery` as a best-effort UI acknowledgement. An expired callback toast must not abort the company-analysis work or trigger the generic retry message.

**Why:** Company analysis refreshes MOEX data before scanning, so Telegram's short callback acknowledgement window can expire while the actual analysis is still valid.