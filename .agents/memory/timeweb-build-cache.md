---
name: Timeweb build cache
description: Timeweb can retain stale workspace declarations after source synchronization.
---

When deploying the full checked-out workspace to Timeweb, rebuild the database library before the API; remove generated `lib/db/dist` and TypeScript build-info files if exports appear missing despite current source files. The systemd service starts `artifacts/api-server/dist/index.mjs` under `/opt/invest-ai/app`, so copying a bundle to the app root does not update the running service.

**Why:** The server retained old generated declarations and the API typecheck reported missing Smart Money exports even though the synced source contained them. A previous deployment also copied the bundle beside, rather than inside, the configured API artifact directory, leaving Telegram on the old code.

**How to apply:** Preserve `/opt/invest-ai/.env`, sync the committed workspace, run the library typecheck/build before the API build, copy the bundle to `/opt/invest-ai/app/artifacts/api-server/dist/index.mjs`, then restart `invest-ai` and verify port 8099 and `/api/healthz`. On the current host, use `/usr/local/bin/pnpm`; the Corepack pnpm shim is incompatible with the installed Node.js runtime.