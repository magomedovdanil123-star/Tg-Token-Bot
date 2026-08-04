---
name: Telegram bot performance
description: Telegram signal commands must use indexed latest-row lookups and support both slash commands and reply-keyboard text.
---

Large historical tables require indexed per-ticker latest-row queries in Telegram handlers; whole-table DISTINCT/sorts make polling appear stalled. Reply-keyboard labels must map to the same handlers as slash commands.

**Why:** The bot could authenticate and receive updates, but `/top` spent tens of seconds scanning and sorting millions of feature rows, while button labels were silently ignored.

**How to apply:** Keep Telegram handlers bounded to current rows and cached research context; when adding buttons, test both the button text and the equivalent slash command.

Raw SQL latest-row timestamps may arrive as strings even though Drizzle schema fields use `mode: "date"`; normalize them to `Date` before passing them into timestamp predicates.

**Why:** The realtime `/top` analysis failed at runtime when a raw-query timestamp was passed directly to a Drizzle timestamp comparison.

**How to apply:** Normalize timestamp values at the boundary of every raw SQL result used by Telegram handlers.

For the TOP command, ranking and eligibility are separate: show the strongest available stocks even when historical evidence is incomplete, and render unavailable metrics as `—` instead of filtering the stock out.

**Why:** The user explicitly wants a simple TOP-5 ordered from best to worst, without statistical thresholds hiding candidates.

**How to apply:** Keep quality metrics visible in the report, but do not use Score, win rate, profit factor, expectancy, test results, or confirmation counts as exclusion gates for `/top`.

The TOP response is intentionally an actionable compact signal: current entry, long/short direction from current factors, historical win rate and occurrences, historical TP/SL with a 0.3% floor, and holding horizon.

**Why:** The user needs a practical one-hour-style forecast rather than a diagnostic dump of every research block.

**How to apply:** Keep the full research engine behind the calculation, but keep `/top` output short; use `—` only when the database truly has no historical value.

`/top` must refresh the latest MOEX candles before calculating signals; reading the latest persisted row alone can produce a valid historical signal with an already-stale entry price.

**Why:** The bot previously reported an old entry while the market price had already moved materially.

**How to apply:** Run a lightweight latest-only import for the active IMOEX universe, update the current candle/features, then analyze; if refresh fails, do not send stale entries.