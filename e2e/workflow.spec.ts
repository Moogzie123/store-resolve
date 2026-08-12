import { expect, test } from '@playwright/test'
test('normal workflow moves from simulation to manager resolution and owner close', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: /new simulated complaint/i }).click()
  await page.getByRole('button', { name: /process complaint/i }).click()
  await expect(page.getByText('Customer complaint')).toBeVisible()
  await page.getByLabel('Act as user').selectOption('manager-1')
  await page.getByRole('button', { name: 'Acknowledge complaint' }).click()
  await page.getByRole('button', { name: 'Start investigation' }).click()
  await page.getByRole('button', { name: 'Record customer contact' }).click()
  await page.getByRole('button', { name: 'Submit resolution' }).click()
  await page.getByLabel('Act as user').selectOption('father')
  await page.getByRole('button', { name: 'Close complaint' }).click()
  await expect(page.getByText('CLOSED', { exact: true })).toBeVisible()
})
test('deadline test clock surfaces owner escalation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /new simulated complaint/i }).click()
  await page.getByRole('button', { name: /process complaint/i }).click()
  await page.getByRole('button', { name: /pilot controls/i }).click()
  await page.getByRole('button', { name: /advance 3 days/i }).click()
  await page.getByRole('button', { name: 'Overview' }).click()
  await expect(page.getByText('Manager acknowledgment overdue')).toBeVisible()
})
