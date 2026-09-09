---
title: "Move database credentials out of the checked-in config file"
type: bug
priority: high
status: todo
order: 110
created: '2026-05-01T19:00:00.000Z'
updated: '2026-05-02T19:00:00.000Z'
project: eval-fixture
---

The database username and password sit in a committed configuration file, so every developer clone carries production-shaped credentials and the values appear throughout the git history. They should be read from the environment or a secret store, and the historical values must be treated as compromised and rotated.
