---
name: Smart Money causality
description: Smart Money сигналы должны строиться только на закрытых агрегированных барах и оцениваться по отдельному таймфрейму исполнения.
---

Smart Money-сигналы нельзя формировать по текущему незакрытому агрегированному бару: timestamp сетапа должен соответствовать последней доступной закрытой свече, а paper-оценка должна явно использовать таймфрейм исполнения.

**Why:** использование незакрытого 15m бара или другого таймфрейма при проверке исхода создаёт look-ahead bias и завышает качество стратегии.

**How to apply:** при изменениях SMC-сканера исключать текущий бакет из анализа; сохранять execution timeframe в metadata; обновлять HTF-данные перед сканированием, если они устарели.

**Market-context freshness:** A candidate must not use a stale IMOEX regime. If current IMOEX 1m/1h data is missing or older than the signal context, directional SMC entries should be rejected or marked unconfirmed rather than inheriting the last bullish regime.

**Why:** OGKB was labeled as a strong-market LONG while the latest IMOEX candles were from the prior session; the stock then moved only about +0.5% before reaching -1.5%.

**How to apply:** Validate freshness specifically for IMOEX, save the market snapshot timestamp with each candidate, and treat unavailable market context as a hard block for ordinary Smart Money until a fresh update succeeds.