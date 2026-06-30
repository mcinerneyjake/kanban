import { test, expect, type APIRequestContext } from 'playwright/test';

const API = 'http://localhost:3001/api';

// Clean up any tickets matching a given title so stale runs don't cause strict-mode failures.
async function deleteByTitle(request: APIRequestContext, title: string) {
  const res = await request.get(`${API}/tickets`);
  const tickets: { id: string; title: string }[] = await res.json();
  for (const t of tickets.filter((t) => t.title === title)) {
    await request.delete(`${API}/tickets/${t.id}`);
  }
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
  await page.getByText('+ New ticket').click();
  await page.locator('input.title-input').fill('E2E smoke ticket');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.card', { hasText: 'E2E smoke ticket' })).toBeVisible();
  await deleteByTitle(request, 'E2E smoke ticket');
});

test('open card modal then close with Escape', async ({ page, request }) => {
  await page.goto('/');
  await page.getByText('+ New ticket').click();
  await page.locator('input.title-input').fill('Modal close test');
  await page.getByRole('button', { name: 'Create' }).click();

  await page.locator('.card', { hasText: 'Modal close test' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).not.toBeVisible();
  await deleteByTitle(request, 'Modal close test');
});
