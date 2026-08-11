---
name: T-Invest stock analysis
description: Constraints and quality rules for the separate per-stock IMOEX historical research.
---

T-Invest 15m candles must be downloaded in windows no longer than 14 days and deduplicated across windows. The T-Invest instrument lookup may not expose IMOEX as a ticker, so market context must be marked unavailable rather than fabricated.

**Why:** A one-year request is rejected by the API, while individual MOEX shares are available. The first research run also showed that a high out-of-sample win rate can still have negative average return or profit factor below 1.

**How to apply:** Keep per-stock research separate from live Smart Money. Require a minimum out-of-sample sample, positive average return, and profit factor at least 1 before labeling a setup validated; report high-WR but economically bad candidates as weak.