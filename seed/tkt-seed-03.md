---
title: Upgrade CI to Node 20
type: chore
priority: low
status: done
order: 6
created: 2026-06-10T08:00:00.000Z
updated: 2026-06-12T16:45:00.000Z
---

## Description
Bump the GitHub Actions runners from Node 18 to Node 20 (18 is EOL). Update the
`setup-node` version matrix and the engines field in `package.json`.

## Implementation summary
Bumped `actions/setup-node` to `node-version: 20`. Gate green on the upgrade PR.

Tests: none — CI config change.
