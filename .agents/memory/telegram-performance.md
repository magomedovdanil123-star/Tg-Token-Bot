---
name: Telegram bot performance
description: Telegram signal commands must use indexed latest-row lookups and support both slash commands and reply-keyboard text.
---

Large historical tables require indexed per-ticker latest-row queries in Telegram handlers; whole-table DISTINCT/sorts make polling appear stalled. Reply-keyboard labels must map to the same handlers as slash commands.

**Why:** The bot could authenticate and receive updates, but `/top` spent tens of seconds scanning and sorting millions of feature rows, while button labels were silently ignored.

**How to apply:** Keep Telegram handlers bounded to current rows and cached research context; when adding buttons, test both the button text and the equivalent slash command.