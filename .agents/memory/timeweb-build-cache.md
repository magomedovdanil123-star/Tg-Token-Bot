---
name: Timeweb build cache
description: Timeweb can retain stale workspace declarations after source synchronization.
---

When deploying the full checked-out workspace to Timeweb, rebuild the database library before the API; remove generated `lib/db/dist` and TypeScript build-info files if exports appear missing despite current source files.

**Why:** The server retained old generated declarations and the API typecheck reported missing Smart Money exports even though the synced source contained them.

**How to apply:** Preserve `/opt/invest-ai/.env`, sync the committed workspace, run the library typecheck/build before the API build, then restart `invest-ai` and verify port 8099 and `/api/healthz`.