---
name: Smart Money filtering
description: SMC strategy quality filters should remain small, orthogonal, explainable, and diagnosed by rejection counts.
---

Для Smart Money достаточно нескольких независимых фильтров: режим IMOEX, качество импульса BOS, размер свечи относительно ATR, net R:R после издержек и cooldown по тикеру; каждый отказ должен быть диагностируемым.

**Why:** добавление RSI/MACD и большого числа коррелированных индикаторов перегружает стратегию и повышает риск подгонки, тогда как rejection stats показывают, какой фильтр реально ограничивает поток сигналов.

**How to apply:** при дальнейшей настройке менять один порог за раз, сравнивать paper/backtest на out-of-sample периоде и не ослаблять фильтры только потому, что текущий скан дал мало сигналов.