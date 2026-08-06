---
name: Local Telegram isolation
description: The Replit development API must never poll the production Telegram bot.
---

Local development and preview processes must not start Telegram polling when the production bot runs on Timeweb; only the production service may own the bot token.

**Why:** A second local `getUpdates` consumer intermittently takes control of the same bot token and causes Telegram `Conflict` errors, making the production bot miss commands and alerts.

**How to apply:** Keep Telegram disabled for local development while preserving it for the production service. Never start the API preview with the production bot token enabled.