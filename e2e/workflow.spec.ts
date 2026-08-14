import { expect, request, test } from '@playwright/test'

const identity = async (page: import('@playwright/test').Page, email: string) => {
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': email })
  await page.reload()
}

test('D1 lifecycle survives refresh and separate authenticated sessions', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /new simulated complaint/i }).click()
  await page.getByRole('button', { name: /process complaint/i }).click()
  const caseId = (
    await page
      .getByText(/SR-\d{4}-\d{4}/)
      .first()
      .textContent()
  )?.match(/SR-\d{4}-\d{4}/)?.[0]
  expect(caseId).toBeTruthy()
  await page.reload()
  await expect(page.getByText(caseId!, { exact: true }).first()).toBeVisible()
  await identity(page, 'manager1@example.invalid')
  await page.getByRole('button', { name: 'Complaints' }).click()
  await page.getByText(caseId!).first().click()
  await page.getByRole('button', { name: 'Acknowledge complaint' }).click()
  await page.getByRole('button', { name: 'Start investigation' }).click()
  await page.getByRole('button', { name: 'Record customer contact' }).click()
  await page.getByRole('button', { name: 'Submit resolution' }).click()
  await expect(page.getByText('RESOLUTION SUBMITTED', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('RESOLUTION SUBMITTED', { exact: true })).toBeVisible()
  await identity(page, 'father@example.invalid')
  await page.getByRole('button', { name: 'Complaints' }).click()
  await page.getByText(caseId!).first().click()
  await page.getByRole('button', { name: 'Close complaint' }).click()
  await expect(page.getByText('CLOSED', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('CLOSED', { exact: true })).toBeVisible()
})

test('persistent deadline escalation is idempotent and visible after refresh', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /new simulated complaint/i }).click()
  await page.getByRole('button', { name: /process complaint/i }).click()
  await page.getByRole('button', { name: 'All complaints' }).click()
  await page.getByRole('button', { name: /pilot controls/i }).click()
  await page.getByRole('button', { name: /advance 3 days/i }).evaluate((button) => button.click())
  await page.waitForTimeout(750)
  await page.getByRole('button', { name: 'Overview' }).click()
  await page.reload()
  await expect(page.getByText('Manager acknowledgment overdue').first()).toBeVisible()
})

test('view-only and manager store isolation are enforced by API', async () => {
  const grandfather = await request.newContext({
    extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'grandfather@example.invalid' },
  })
  const bootstrap = await grandfather.get('/api/bootstrap')
  expect(bootstrap.ok()).toBeTruthy()
  const state = (await bootstrap.json()).state
  const complaint = state.complaints[0]
  if (complaint) {
    const denied = await grandfather.post(`/api/complaints/${complaint.id}/actions`, {
      data: { action: 'CLOSE', data: {} },
    })
    expect(denied.status()).toBe(403)
  }
  const manager2 = await request.newContext({
    extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'manager2@example.invalid' },
  })
  const managerState = (await (await manager2.get('/api/bootstrap')).json()).state
  expect(
    managerState.complaints.every(
      (c: { assignedManagerId?: string }) => c.assignedManagerId === 'manager-2',
    ),
  ).toBe(true)
})

test('manual test UI has only owners and requires confirmation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /pilot controls/i }).click()
  const options = await page
    .locator('.settings-card')
    .filter({ hasText: 'Test notification' })
    .locator('option')
    .allTextContents()
  expect(options).toHaveLength(4)
  expect(options.join(' ')).toContain('Pilot Admin Test')
  expect(options.join(' ')).not.toContain('Manager')
  await expect(page.getByRole('button', { name: 'Send one confirmed test' })).toBeDisabled()
})
