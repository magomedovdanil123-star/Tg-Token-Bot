---
name: Timeweb deployment
description: Deployment constraints and operating assumptions for the external Timeweb server.
---

The Timeweb host already runs another service on port 8080, so Invest AI must use a separate port (currently 8099). The application is managed by a dedicated `invest-ai` systemd service and uses a local PostgreSQL database restored from the research database.

**Why:** Binding to 8080 caused systemd restart loops and would have disrupted an unrelated service. The external GitHub repository is private, so a server-side deploy key is required for future pulls.

**How to apply:** Keep the existing service on 8080 untouched. Add the server's public deploy key to the GitHub repository, configure `TELEGRAM_BOT_TOKEN` in the server-only environment file, then use the prepared update script and verify `/api/healthz` plus Telegram bot connection logs. The systemd service runs `/opt/invest-ai/app`, while the Git clone is `/opt/invest-ai/repo`; update the clone, preserve any local stash, sync the working copy, build, and restart `invest-ai`. External PostgreSQL schema may lag the code; Drizzle push can require interactive conflict resolution, so verify newly required tables before testing features.