---
title: SSO login fails on Safari
type: bug
priority: high
status: in-progress
order: 3
created: 2026-06-18T09:00:00.000Z
updated: 2026-06-22T14:30:00.000Z
---

## Description
Users on Safari 17 are bounced back to the login screen after the SAML redirect.
Chrome and Firefox are unaffected. Suspected `SameSite=Lax` cookie dropped on the
cross-site POST back from the IdP.

## Notes
- Repro: Safari → "Login with SSO" → redirects, lands back on `/login`.
- Likely fix: set `SameSite=None; Secure` on the session cookie.
