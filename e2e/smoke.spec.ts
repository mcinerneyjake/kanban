import { test, expect } from 'playwright/test'

test('board shows all 5 column headers', async ({ page }) => {
  await page.goto('/')
  for (const label of ['Backlog', 'Todo', 'In Progress', 'QA', 'Done']) {
    await expect(page.locator('.column-header', { hasText: label })).toBeVisible()
  }
})

test('create a new ticket and see it on the board', async ({ page }) => {
  await page.goto('/')
  await page.getByText('+ New ticket').click()
  await page.locator('input.title-input').fill('E2E smoke ticket')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.locator('.card', { hasText: 'E2E smoke ticket' })).toBeVisible()
})

test('open card modal then close with Escape', async ({ page }) => {
  await page.goto('/')

  // Create a card so there is definitely one to click.
  await page.getByText('+ New ticket').click()
  await page.locator('input.title-input').fill('Modal close test')
  await page.getByRole('button', { name: 'Create' }).click()

  await page.locator('.card', { hasText: 'Modal close test' }).click()
  await expect(page.locator('.modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal')).not.toBeVisible()
})
