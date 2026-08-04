---
name: Research database alignment
description: Non-obvious compatibility details for the research tables and refresh workflow.
---

The existing research database is not guaranteed to match the newest Drizzle names exactly. In particular, pattern occurrence timestamps are stored under the live `timestamp` column, so schema extensions must map to that column rather than assuming a semantic name such as `occurred_at`.

**Why:** A first pattern-discovery write reached the aggregate stage successfully but failed at the occurrence insert because the deployed table used the older live column name.

**How to apply:** Before adding research tables or raw SQL inserts, inspect `information_schema.columns` and preserve existing column names. Prefer idempotent unique keys and `ON CONFLICT` updates for rerunnable historical refreshes.