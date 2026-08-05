---
name: Telegram alert subscriptions
description: Background Smart Money and Money Test scans must be connected to subscribed Telegram chats before new signals can be delivered.
---

Background scanning and Telegram delivery are separate concerns. A scanner can run successfully and record zero or more paper candidates without sending anything unless the relevant chat is in the notifier subscription set.

**Why:** The bot was actively refreshing MOEX data and running both Smart Money and Money Test cycles, but ordinary Smart Money had no outbound notification path while Money Test already had one.

**How to apply:** When adding or changing a background alert stream, verify all three pieces together: scan cadence, new-record detection, and persisted chat subscription/delivery. Keep alert eligibility tied to recorded new candidates; do not weaken strategy filters merely to make notifications appear.