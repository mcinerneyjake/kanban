---
title: list_tickets overflows the tool-output cap at scale
type: bug
priority: medium
status: backlog
created: 2026-07-04T09:00:00.000Z
updated: 2026-07-04T09:00:00.000Z
order: 70
project: kanban
---

The list_tickets tool returns every ticket on the board in a single response. Once the board grows to a few hundred tickets the payload exceeds the MCP tool-output size limit and the call truncates or fails. It needs a default limit plus status/project filters so the slim payload stays under the cap.
