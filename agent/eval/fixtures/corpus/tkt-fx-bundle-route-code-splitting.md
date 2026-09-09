---
title: "Code-split the application by route"
type: feature
priority: high
status: backlog
order: 154
created: '2026-05-03T15:00:00.000Z'
updated: '2026-05-04T15:00:00.000Z'
project: eval-fixture
---

The whole application ships as one bundle, so opening any page downloads the code for every other page first. Routes should load their own chunks on navigation, with the shell kept small enough to paint immediately.
