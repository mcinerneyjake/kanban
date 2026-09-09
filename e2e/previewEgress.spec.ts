import { test, expect, type APIRequestContext, type Page } from 'playwright/test';
import { apiBaseUrl } from '../shared/ports.js';

const API = `${apiBaseUrl()}/api`;

// Every remote reference in the fixtures below points at this host. Nothing resolves it: the
// route handler aborts before the request leaves, so a red run costs no real network.
const ATTACKER = 'attacker.example';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const EGRESS_TITLE = 'E2E preview egress';
const CONTROL_TITLE = 'E2E preview control';

// A marker rendered as plain text, asserted visible in every fixture. Without it a preview pane
// that rendered NOTHING would satisfy "zero outbound requests" just as well as a fixed one.
const MARKER = 'EGRESS PROBE MARKER';

// One case per egress dimension. `marked` passes raw HTML through untouched, so a body reaches
// DOMPurify carrying whatever tags its author wrote — the reported `![](…)` vector is only the
// dimension that happens to have markdown syntax. The <style>-element and <feImage> cases came
// from the tkt-5037f1a9fb57 review: the first fires through BOTH layers when style-src/font-src
// are absent, the second survives the sanitizer denylist and is stopped only by img-src.
const EGRESS_BODY = [
  MARKER,
  '',
  `![md](https://${ATTACKER}/a?d=md)`,
  '',
  `<img src="https://${ATTACKER}/b?d=img">`,
  `<img srcset="https://${ATTACKER}/c?d=srcset 1x">`,
  `<video src="https://${ATTACKER}/d?d=video" poster="https://${ATTACKER}/e?d=poster"></video>`,
  `<audio src="https://${ATTACKER}/f?d=audio"></audio>`,
  `<video><source src="https://${ATTACKER}/g?d=source"></video>`,
  `<video><track src="https://${ATTACKER}/h?d=track"></video>`,
  `<input type="image" src="https://${ATTACKER}/i?d=input">`,
  `<svg><image href="https://${ATTACKER}/j?d=svgimage"></image></svg>`,
  `<svg><image xlink:href="https://${ATTACKER}/k?d=xlink"></image></svg>`,
  `<svg><use href="https://${ATTACKER}/l?d=svguse"></use></svg>`,
  `<div style="background-image:url(https://${ATTACKER}/m?d=cssbg)">bg</div>`,
  `<object data="https://${ATTACKER}/n?d=object"></object>`,
  `<embed src="https://${ATTACKER}/o?d=embed">`,
  `<iframe src="https://${ATTACKER}/p?d=iframe"></iframe>`,
  `<style>@import url("https://${ATTACKER}/q?d=cssimport");</style>`,
  `<style>@font-face{font-family:zz;src:url("https://${ATTACKER}/r?d=cssfont")}#zz{font-family:zz}</style>`,
  '<div id="zz">font</div>',
  `<svg><style>@import url("https://${ATTACKER}/s?d=svgstyle");</style></svg>`,
  `<svg><filter id="fe"><feImage href="https://${ATTACKER}/t?d=feimage"/></filter>`,
  '<rect width="10" height="10" filter="url(#fe)"/></svg>',
].join('\n');

// The negative control. It carries an external URL in an <a href>, which must NOT fetch: that
// separates "this preview makes no requests" from "this preview strips every URL it sees".
const CONTROL_BODY = [
  `# ${MARKER}`,
  '',
  `A [link](https://${ATTACKER}/never-fetched) and \`code\`.`,
  '',
  '- [ ] task list stays checkable',
].join('\n');

async function deleteByTitle(request: APIRequestContext, title: string) {
  const res = await request.get(`${API}/tickets`);
  const board: { tickets: { id: string; title: string }[] } = await res.json();
  for (const t of board.tickets.filter((t) => t.title === title)) {
    await request.delete(`${API}/tickets/${t.id}`);
  }
}

// Records — and aborts — anything addressed outside the app's own origin. Registered before the
// first navigation so nothing slips through, and deliberately host-based rather than a match on
// ATTACKER: a vector that rewrote the host would otherwise pass unnoticed.
async function captureEgress(page: Page): Promise<string[]> {
  const hits: string[] = [];
  await page.route(
    (url) => !LOCAL.has(url.hostname),
    async (route) => {
      hits.push(route.request().url());
      await route.abort();
    },
  );
  return hits;
}

// Serves the app with its CSP <meta> removed, so the assertions can see what the SANITIZER alone
// does. Without this the spec cannot fail on a PREVIEW_SANITIZE change at all: a CSP-blocked
// subresource never reaches the network stack, so `page.route` never sees it and `hits` stays
// empty whatever the sanitizer did (tkt-5037f1a9fb57 review, finding 3).
async function stripCspMeta(page: Page) {
  await page.route(
    (url) => LOCAL.has(url.hostname) && url.pathname === '/',
    async (route) => {
      const res = await route.fetch();
      const html = await res.text();
      const stripped = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '');
      // The strip is itself an instrument: if the markup changes shape and the regex stops
      // matching, this arm would silently retest the CSP-on case and report a false green.
      if (stripped === html) throw new Error('stripCspMeta matched nothing — instrument is broken');
      await route.fulfill({ response: res, body: stripped });
    },
  );
}

async function openPreview(page: Page, title: string) {
  await page.goto('/');
  await page.locator('.card', { hasText: title }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Preview', exact: true }).click();
  const pane = page.locator('.md-preview');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText(MARKER);
  // Subresource loads are dispatched after render, and there is no event for "no request is
  // coming". Rather than trust a bare sleep — which fails OPEN under load, returning the
  // permissive answer — await a real same-origin round trip first, so the window is proven to
  // have outlived at least one full network dispatch.
  await page.evaluate(async () => { await fetch('/api/tickets').then((r) => r.text()); });
  await page.waitForTimeout(750);
  return pane;
}

async function seed(request: APIRequestContext, title: string, body: string) {
  const res = await request.post(`${API}/tickets`, { data: { title, body } });
  expect(res.status()).toBe(201);
}

test.beforeEach(async ({ request }) => {
  await deleteByTitle(request, EGRESS_TITLE);
  await deleteByTitle(request, CONTROL_TITLE);
});

test.afterEach(async ({ request }) => {
  await deleteByTitle(request, EGRESS_TITLE);
  await deleteByTitle(request, CONTROL_TITLE);
});

// The positive control for every `toEqual([])` below. If the route predicate stopped matching —
// a baseURL change, an IPv6 host, a Playwright signature change — those zeros would all be
// vacuous and nothing else in this file would notice.
test('the egress interceptor actually records a cross-origin request', async ({ page }) => {
  const hits = await captureEgress(page);
  await page.goto('/');
  await page.evaluate(async (host) => {
    await fetch(`https://${host}/instrument-probe`).catch(() => {});
  }, ATTACKER);
  await expect.poll(() => hits.length).toBe(1);
  expect(hits[0]).toContain('instrument-probe');
});

test('preview of a body full of remote references makes no outbound request', async ({
  page,
  request,
}) => {
  const hits = await captureEgress(page);
  await seed(request, EGRESS_TITLE, EGRESS_BODY);

  await openPreview(page, EGRESS_TITLE);

  expect(hits, `preview leaked to ${hits.length} external URL(s)`).toEqual([]);
});

// The same body with layer 2 removed. This is the arm that gives PREVIEW_SANITIZE its regression
// coverage — and the only one a mutation of the sanitizer config can turn red.
test('the sanitizer alone blocks every vector, with the CSP stripped', async ({ page, request }) => {
  const hits = await captureEgress(page);
  await stripCspMeta(page);
  await seed(request, EGRESS_TITLE, EGRESS_BODY);

  await openPreview(page, EGRESS_TITLE);

  // Proves layer 2 really is absent for this arm, so a green here is about the sanitizer.
  const cspMetas = await page.locator('meta[http-equiv="Content-Security-Policy"]').count();
  expect(cspMetas, 'CSP meta should be stripped in this arm').toBe(0);
  expect(hits, `sanitizer alone leaked to ${hits.length} external URL(s)`).toEqual([]);
});

test('preview still renders markdown, and an <a href> is not a fetch', async ({ page, request }) => {
  const hits = await captureEgress(page);
  await seed(request, CONTROL_TITLE, CONTROL_BODY);

  const pane = await openPreview(page, CONTROL_TITLE);

  // Rendering is intact: the heading became an element, the code span survived, and the link is
  // still a link carrying its href.
  await expect(pane.locator('h1')).toContainText(MARKER);
  await expect(pane.locator('code')).toHaveText('code');
  await expect(pane.locator('a')).toHaveAttribute('href', `https://${ATTACKER}/never-fetched`);
  // Pins the narrowest form of the fix: `input` is NOT in FORBID_TAGS, because its only egress
  // shape (type=image) is already disarmed by dropping `src`. Banning the tag would pass the
  // egress tests above while silently deleting every task-list checkbox on the board.
  await expect(pane.locator('input[type="checkbox"]')).toHaveCount(1);

  expect(hits, `control leaked to ${hits.length} external URL(s)`).toEqual([]);
});
