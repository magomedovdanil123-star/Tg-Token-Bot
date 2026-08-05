---
name: Commodity Smart Money
description: Durable boundaries for the Telegram commodity scanner and its paper-signal monitoring.
---

Commodity Smart Money is a separate universe from IMOEX. The supported instruments are XAUUSD, XAGUSD, and BRENT, stored in the shared candles table but registered inactive so they do not enter the IMOEX universe.

**Why:** Commodity futures come from Yahoo Finance rather than MOEX and have different market behavior; mixing their outcomes or regime with IMOEX would distort adaptive thresholds and signal quality.

**How to apply:** Keep the source identifier `commodity-smartmoney` separate from `smartmoney`, calculate the commodity regime from the commodity 1H series, and preserve the existing IMOEX scan behavior when extending the scanner.

The Telegram commodity monitor refreshes 1m data and scans approximately every three minutes. It may send only validated paper signals and one-time REDUCE/EXIT events for TP levels, stop/invalidation, structure failure, or severe relative-volume decline; no message means no valid entry.