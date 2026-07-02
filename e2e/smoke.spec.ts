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
    await page.getByRole('button', { name: /draft ticket/i }).click();
    const manual = page.getByRole('button', { name: /enter manually/i });
    await expect(title.or(manual)).toBeVisible({ timeout: 25_000 });
    if (await manual.isVisible()) await manual.click();
  }
  return title;
}

test.beforeEach(async ({ request }) => {
  await deleteByTitle(request, 'E2E smoke ticket');
  await deleteByTitle(request, 'Modal close test');
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
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.card', { hasText: 'E2E smoke ticket' })).toBeVisible();
  await deleteByTitle(request, 'E2E smoke ticket');
});

test('open card modal then close with Escape', async ({ page, request }) => {
  await page.goto('/');
  const title = await openCreateForm(page);
  await title.fill('Modal close test');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.card', { hasText: 'Modal close test' })).toBeVisible();

  await page.locator('.card', { hasText: 'Modal close test' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).not.toBeVisible();
  await deleteByTitle(request, 'Modal close test');
});
