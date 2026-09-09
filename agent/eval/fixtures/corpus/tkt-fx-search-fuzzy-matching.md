---
title: "Add fuzzy matching to the search endpoint"
type: feature
priority: medium
status: backlog
order: 106
created: '2026-05-01T15:00:00.000Z'
updated: '2026-05-02T15:00:00.000Z'
project: eval-fixture
---

Search only matches exact substrings, so a small typo returns nothing at all and users conclude the record is missing. The endpoint should tolerate transpositions and near-misses, ranking exact matches above fuzzy ones so precision does not collapse.
