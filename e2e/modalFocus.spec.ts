import { test, expect, type APIRequestContext } from 'playwright/test';
import { apiBaseUrl } from '../shared/ports.js';

const API = `${apiBaseUrl()}/api`;

const PARENT = 'focus-restore e2e: parent';
const CHILD = 'focus-restore e2e: child';

async function deleteByTitle(request: APIRequestContext, ...titles: string[]) {
  const board: { tickets: { id: string; title: string }[] } = await (await request.get(`${API}/tickets`)).json();
  for (const t of board.tickets.filter((t) => titles.includes(t.title))) {
    await request.delete(`${API}/tickets/${t.id}`);
  }
}

// tkt-75ac08441da5. TicketModal is keyed by ticket id, so following a sub-ticket link UNMOUNTS the modal
// and mounts a new one — whose captured focus target is the link that died with the old instance. focus()
// on a detached node silently no-ops, so closing left a keyboard user on <body> at the top of the document.
//
// Playwright rather than vitest because this is a real focus/DOM-lifecycle behaviour and this repo's vitest
// is node-env with no DOM. The decision itself is unit-tested in src/lib/focusRestore.test.ts; what only a
// browser can show is that the remount actually detaches the trigger.
test.describe('focus restore after in-modal navigation', () => {
  let parentId = '';
  let childId = '';

  test.beforeEach(async ({ request }) => {
    await deleteByTitle(request, PARENT, CHILD);
    const parent: { id: string } = await (await request.post(`${API}/tickets`, {
      data: { title: PARENT, type: 'task', priority: 'medium', status: 'backlog' },
    })).json();
    parentId = parent.id;
    const child: { id: string } = await (await request.post(`${API}/tickets`, {
      data: { title: CHILD, type: 'task', priority: 'medium', status: 'backlog', parent: parent.id },
    })).json();
    childId = child.id;
  });

  test.afterEach(async ({ request }) => {
    await deleteByTitle(request, PARENT, CHILD);
  });

  test('lands on the card of the ticket last viewed, not on <body>', async ({ page }) => {
    await page.goto('/');
    const parentCard = page.locator(`[data-ticket-id="${parentId}"]`);
    await expect(parentCard).toBeVisible();
    await parentCard.click();

    // Navigate parent → child inside the modal. This is the remount that strands the captured trigger.
    const childLink = page.locator('.subtask-item', { hasText: CHILD });
    await expect(childLink).toBeVisible();
    await childLink.click();
    await expect(page.locator('.modal input.title-input')).toHaveValue(CHILD);

    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      ticketId: document.activeElement?.getAttribute('data-ticket-id') ?? null,
    }));
    // Before the fix this was { tag: 'BODY', ticketId: null }.
    expect(focused.tag).not.toBe('BODY');
    expect(focused.ticketId).toBe(childId);
  });

  // The control: the ordinary open/close path must still restore to the trigger itself. Without this, a
  // fix that always jumped to the ticket's card would look correct while quietly changing normal behaviour.
  test('an ordinary open/close still restores the card that was clicked', async ({ page }) => {
    await page.goto('/');
    const parentCard = page.locator(`[data-ticket-id="${parentId}"]`);
    await expect(parentCard).toBeVisible();
    await parentCard.click();
    await expect(page.locator('.modal input.title-input')).toHaveValue(PARENT);

    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-ticket-id') ?? null))
      .toBe(parentId);
  });
});
