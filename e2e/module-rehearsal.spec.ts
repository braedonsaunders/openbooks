import { expect, test } from '@playwright/test'
import { authedContext, dismissSetupWizard } from './auth'

// An existing ready sandbox with the cloned admin is provisioned by the e2e harness.
test('module rehearsal renders the real sandbox route, promotes, and discards without changing production', async ({ browser, baseURL }) => {
  test.skip(!process.env.E2E_SANDBOX_NAME, 'A ready module rehearsal sandbox fixture is required')
  test.slow()
  const { context, page } = await authedContext(browser, baseURL)
  const key = 'rehearsal-browser-proof'
  const manifest = {
    key, name: 'Rehearsal browser proof', version: '1.0.0', permissions: [],
    contributions: [{ kind: 'page', route: '/purchasing', spec: {
      specVersion: 1, route: '/purchasing', layout: 'list', header: [],
      body: [{ kind: 'text', content: 'Sandbox rehearsal rendered' }],
    } }],
  }
  async function fillManifest() {
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Module manifest', { exact: true }).fill(JSON.stringify(manifest))
    await drawer.getByLabel('Reason', { exact: true }).fill('Verify sandbox rehearsal workflow')
    await drawer.getByRole('combobox', { name: 'Rehearsal sandbox' }).selectOption({ label: process.env.E2E_SANDBOX_NAME! })
  }
  try {
    await page.goto('/admin/modules?new=1')
    await dismissSetupWizard(page)
    await fillManifest()
    await page.getByRole('button', { name: 'Stage in sandbox', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open preview /purchasing', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Review sandbox changes', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Review changes' })).toBeVisible()
    await page.locator('[data-splash-root]').waitFor({ state: 'hidden' })
    if (process.env.E2E_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.E2E_ARTIFACT_DIR}/module-rehearsal-diff.png`, fullPage: true })
    await page.getByRole('button', { name: 'Open preview /purchasing', exact: true }).click()
    await expect(page).toHaveURL(/\/purchasing\?layoutPreview=1/)
    await expect(page.locator('main').getByText('Sandbox rehearsal rendered', { exact: true })).toBeVisible()
    await expect(page.getByText(/Sandbox environment/)).toBeVisible()
    await dismissSetupWizard(page)
    await page.locator('[data-splash-root]').waitFor({ state: 'hidden' })
    if (process.env.E2E_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.E2E_ARTIFACT_DIR}/module-sandbox-preview.png`, fullPage: true })
    await page.getByRole('button', { name: 'Exit to production', exact: true }).click()
    await expect(page.getByText(/Sandbox environment/)).toHaveCount(0)
    await page.goto('/admin/modules?new=1')
    await fillManifest()
    await page.getByRole('button', { name: 'Review sandbox changes', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Review changes' })).toBeVisible()
    await page.getByRole('button', { name: 'Promote rehearsal', exact: true }).click()
    const promote = page.getByRole('dialog', { name: 'Promote the staged version to production' })
    await promote.getByRole('textbox').fill('Promote the verified sandbox route')
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/admin/modules') && r.request().method() === 'POST'),
      promote.getByRole('button', { name: 'Promote rehearsal', exact: true }).click(),
    ])
    expect(response.ok(), await response.text()).toBeTruthy()
    await page.goto('/purchasing')
    await expect(page.locator('main').getByText('Sandbox rehearsal rendered', { exact: true })).toBeVisible()
    await page.goto(`/admin/modules?module=${key}`)
    await page.getByRole('button', { name: 'Discard rehearsal', exact: true }).click()
    const discard = page.getByRole('dialog', { name: 'Discard this sandbox rehearsal' })
    await discard.getByRole('textbox').fill('Rehearsal is complete')
    const [discarded] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/admin/modules') && r.request().method() === 'POST'),
      discard.getByRole('button', { name: 'Discard rehearsal', exact: true }).click(),
    ])
    expect(discarded.ok(), await discarded.text()).toBeTruthy()
    await page.goto('/purchasing')
    await expect(page.locator('main').getByText('Sandbox rehearsal rendered', { exact: true })).toBeVisible()
  } finally {
    try { await page.request.post('/api/admin/modules', { data: { action: 'deactivate', key, reason: 'Browser rehearsal verification cleanup' }, headers: { Origin: new URL(baseURL!).origin } }) }
    finally { await context.close() }
  }
})
