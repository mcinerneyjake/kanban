import { test, expect, type APIRequestContext, type Page } from 'playwright/test';

const API = 'http://localhost:3001/api';

// Clean up any tickets matching a given title so stale runs don't cause strict-mode failures.
async function deleteByTitle(request: APIRequestContext, title: string) {
  const res = await request.get(`${API}/tickets`);
  const tickets: { id: string; title: string }[] = await res.json();
  for (const t of tickets.filter((t) => t.title === title)) {
    await request.delete(`${API}/tickets/${t.id}`);
  }
}

// Reach the manual create form. The create modal is AI-first: with the drafting
// model down (playwright.config points it at a dead port) it shows the manual
// form directly; if a model happens to be up it shows the "Draft from a note"
// panel, from which we draft once to surface the form (or its "enter manually"
// escape). Returns the title input, ready to fill.
async function openCreateForm(page: Page) {
  await page.getByText('+ New ticket').click();
  const title = page.locator('.modal input.title-input');
  const draftPanel = page.locator('.draft-panel');
  await expect(title.or(draftPanel)).toBeVisible();
  if (!(await title.isVisible())) {
    await page.locator('.draft-input').fill('smoke test: create a ticket');
    // Scope to the draft panel: cards are now role="button" and their accessible
    // names ("Open ticket: …") can otherwise collide with these substring regexes.
    await page.locator('.draft-panel').getByRole('button', { name: /draft ticket/i }).click();
    const manual = page.locator('.draft-panel').getByRole('button', { name: /enter manually/i });
    await expect(title.or(manual)).toBeVisible({ timeout: 25_000 });
    if (await manual.isVisible()) await manual.click();
  }
  return title;
}

test.beforeEach(async ({ request }) => {
  await deleteByTitle(request, 'E2E smoke ticket');
  await deleteByTitle(request, 'Modal close test');
  await deleteByTitle(request, 'A11y backdrop test');
  await deleteByTitle(request, 'A11y keyboard test');
});

test('board shows all 5 column headers', async ({ page }) => {
  await page.goto('/');
  for (const label of ['Backlog', 'Todo', 'In Progress', 'QA', 'Done']) {
    await expect(page.locator('.column-header', { hasText: label })).toBeVisible();
  }
});

test('create a new ticket and see it on the board', async ({ page, request }) => {
  await page.goto('/');
  const title = await openCreateForm(page);
  await title.fill('E2E smoke ticket'); // overwrite any AI-drafted title
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'E2E smoke ticket' })).toBeVisible();
  await deleteByTitle(request, 'E2E smoke ticket');
});

test('open card modal then close with Escape', async ({ page, request }) => {
  await page.goto('/');
  const title = await openCreateForm(page);
  await title.fill('Modal close test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'Modal close test' })).toBeVisible();

  await page.locator('.card', { hasText: 'Modal close test' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).not.toBeVisible();
  await deleteByTitle(request, 'Modal close test');
});

// Accessibility (tkt-3d41293158f8): the open modal is a real dialog.
test('modal exposes dialog semantics', async ({ page, request }) => {
  await page.goto('/');
  const title = await openCreateForm(page);
  await title.fill('A11y keyboard test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'A11y keyboard test' })).toBeVisible();

  await page.locator('.card', { hasText: 'A11y keyboard test' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await deleteByTitle(request, 'A11y keyboard test');
});

// Cards are keyboard-operable: focus a card and press Enter to open it.
test('card opens via keyboard (Enter)', async ({ page, request }) => {
  await page.goto('/');
  const title = await openCreateForm(page);
  await title.fill('A11y keyboard test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const card = page.locator('.card', { hasText: 'A11y keyboard test' });
  await expect(card).toBeVisible();

  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await deleteByTitle(request, 'A11y keyboard test');
});

// Data-loss guard: a press that STARTS inside the panel and releases on the
// backdrop (e.g. selecting text in the body textarea) must NOT close the modal.
// Uses real mouse events so mousedown/mouseup land on different targets — a
// synthetic click can't reproduce the browser's common-ancestor dispatch.
test('backdrop does not close on a press that started inside the panel', async ({ page, request }) => {
  await page.goto('/');
  const title = await openCreateForm(page);
  await title.fill('A11y backdrop test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'A11y backdrop test' })).toBeVisible();

  await page.locator('.card', { hasText: 'A11y backdrop test' }).click();
  await expect(page.locator('.modal')).toBeVisible();

  // A point provably on the backdrop but outside the panel: to the RIGHT of the
  // centered panel (the sidebar rail overlays the LEFT edge, so avoid that side).
  const body = page.locator('.modal .body-input');
  const bodyBox = await body.boundingBox();
  const panelBox = await page.locator('.modal').boundingBox();
  const backdropBox = await page.locator('.modal-backdrop').boundingBox();
  if (!bodyBox || !panelBox || !backdropBox) throw new Error('missing layout boxes');
  const outsideX = (panelBox.x + panelBox.width + backdropBox.x + backdropBox.width) / 2;
  const outsideY = panelBox.y + panelBox.height / 2;

  // Press starts on the body textarea, releases out on the backdrop.
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(outsideX, outsideY);
  await page.mouse.up();
  await expect(page.locator('.modal')).toBeVisible();

  // A genuine backdrop press (down + up on the backdrop) still closes it.
  await page.mouse.move(outsideX, outsideY);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.modal')).not.toBeVisible();
  await deleteByTitle(request, 'A11y backdrop test');
});
