import { expect, test } from '@playwright/test'
import { authedContext, dismissSetupWizard, loginViaForm } from './auth'

// Requires a second independently authenticated administrator in the e2e org.
test('signed module approval uses the worklist and its setting is editable through shared setup', async ({ browser, baseURL }) => {
  test.skip(!process.env.E2E_APPROVER_EMAIL, 'An independent module approver fixture is required')
  test.slow()
  const { context, page } = await authedContext(browser, baseURL)
  const approverContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1" })
  const approver = await approverContext.newPage()
  const key = `browser-settings-${Date.now()}`
  try {
    await page.goto('/admin/modules?new=1')
    await dismissSetupWizard(page)
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Module manifest', { exact: true }).fill(JSON.stringify({
      key, name: 'Browser settings proof', version: '1.0.0', permissions: ['admin.setup.manage'],
      contributions: [{ kind: 'setting', key: 'review_window', label: 'Review window', valueType: 'string', defaultValue: 'Daily' }],
    }))
    await drawer.getByLabel('Reason', { exact: true }).fill('Review settings installation with independent signed approval')
    await drawer.getByRole('button', { name: 'Apply or request approval', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`module=${key}`))
    await expect(drawer.getByRole('button', { name: /Sign and apply/ })).toHaveCount(0)

    await loginViaForm(approver, process.env.E2E_APPROVER_EMAIL!, process.env.E2E_APPROVER_PASSWORD ?? process.env.E2E_PASSWORD!)
    await expect(approver).not.toHaveURL(/\/login/)
    await approver.goto('/approvals')
    await dismissSetupWizard(approver)
    const row = approver.getByRole('row').filter({ hasText: key })
    await row.getByRole('button', { name: 'Approve', exact: true }).click()
    const signature = approver.getByRole('dialog', { name: 'Sign to approve' })
    await signature.getByRole('textbox').fill('Module Approver')
    await signature.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(row).toHaveCount(0)
    await approver.goto(`/admin/modules?module=${key}`)
    await expect(approver.getByRole('dialog').getByText('Active', { exact: true }).first()).toBeVisible()
    await approver.locator('[data-splash-root]').waitFor({ state: 'hidden' })
    if (process.env.E2E_ARTIFACT_DIR) await approver.screenshot({ path: `${process.env.E2E_ARTIFACT_DIR}/signed-module-drawer.png`, fullPage: true })

    await approver.goto('/admin/setup/module-settings')
    const setting = approver.getByRole('row').filter({ hasText: key })
    await setting.getByRole('link').first().click()
    const setup = approver.getByRole('dialog')
    await setup.getByLabel('Value', { exact: true }).fill('Weekly')
    await setup.getByLabel('Reason for change', { exact: true }).fill('Verify effective-dated module setting editing')
    await setup.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(setup).toHaveCount(0)
    await expect(setting.getByText('Weekly', { exact: true })).toBeVisible()
    await approver.locator('[data-splash-root]').waitFor({ state: 'hidden' })
    if (process.env.E2E_ARTIFACT_DIR) await approver.screenshot({ path: `${process.env.E2E_ARTIFACT_DIR}/module-settings.png`, fullPage: true })
  } finally {
    try { await page.request.post('/api/admin/modules', { data: { action: 'deactivate', key, reason: 'Browser approval verification cleanup' }, headers: { Origin: new URL(baseURL!).origin } }) }
    finally { await Promise.all([context.close(), approverContext.close()]) }
  }
})
