---
name: Pattern discovery scale
description: Operational constraints for large-scale candle, chart-pattern, and SMC discovery.
---

Structural chart and SMC patterns describe zones that may remain valid across many bars. Persisting every matching bar creates millions of duplicate events and can exhaust the research run before statistics are saved.

**Why:** The two-year, 10-minute universe contains tens of thousands of bars per ticker; unsampled structural detection produced an event explosion and delayed aggregate statistics.

**How to apply:** Use pattern-specific cooldowns and structural sampling, and persist per-ticker statistics immediately so a long multi-ticker refresh remains resumable and does not lose completed work.