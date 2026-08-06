---
name: Development schema changes
description: How to handle Drizzle schema updates when the database contains named-schema conflicts.
---

Drizzle schema changes must flow through the standard development post-merge setup and publish process. If `drizzle-kit push` or `push-force` still requests an interactive resolution because of an existing named-schema conflict, do not invent a deploy-time or startup-time migration path.

**Why:** The CLI can stop before applying an otherwise additive table change when no TTY is available, while direct or deploy-time DDL would bypass the workspace's supported schema lifecycle.

**How to apply:** Keep the source schema updated, inspect the conflict, and use the project's post-merge setup for development and Publish for production. Never add schema mutation to application startup or deployment build commands.