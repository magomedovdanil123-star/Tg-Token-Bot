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