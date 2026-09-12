import { expect, test } from '@playwright/test'
import { authedContext, dismissSetupWizard } from './auth'

// This proves the controls operate on the real page renderer and rollback
// appends restoring history, rather than just exercising API helper outputs.
test('module drawer installs, upgrades, renders, and rolls back a page contribution', async ({ browser, baseURL }) => {
  test.slow()
  const { context, page } = await authedContext(browser, baseURL)
  const key = `browser-module-${Date.now()}`
  const manifest = (version: string) => ({
    key, name: 'Browser module proof', version, permissions: [],
    contributions: [{ kind: 'page', route: '/banking', spec: {
      specVersion: 1, route: '/banking', layout: 'list', header: [],
      body: [{ kind: 'text', content: `Module rendered ${version}` }],
    } }],
  })
  try {
    await page.goto('/admin/modules')
    await dismissSetupWizard(page)
    await page.getByRole('link', { name: 'New module', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Module manifest', { exact: true }).fill(JSON.stringify(manifest('1.0.0')))
    await drawer.getByLabel('Reason', { exact: true }).fill('Verify first module render')
    await drawer.getByRole('button', { name: 'Review changes', exact: true }).click()
    await expect(drawer.getByText('Added', { exact: true })).toBeVisible()
    await drawer.getByRole('button', { name: 'Apply or request approval', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`module=${key}`))
    await page.goto('/banking')
    await expect(page.locator('main').getByText('Module rendered 1.0.0', { exact: true })).toBeVisible()
    await page.goto(`/admin/modules?module=${key}`)
    await drawer.getByLabel('Module manifest', { exact: true }).fill(JSON.stringify(manifest('2.0.0')))
    await drawer.getByLabel('Reason', { exact: true }).fill('Verify upgraded module render')
    await drawer.getByRole('button', { name: 'Apply or request approval', exact: true }).click()
    await expect(drawer.getByRole('button', { name: 'Roll back', exact: true })).toBeVisible()
    await page.goto('/banking')
    await expect(page.locator('main').getByText('Module rendered 2.0.0', { exact: true })).toBeVisible()
    await page.goto(`/admin/modules?module=${key}`)
    await drawer.getByRole('button', { name: 'Roll back', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: 'Restore the previous module version' })
    await prompt.getByRole('textbox').fill('Restore known-good module version')
    await prompt.getByRole('button', { name: 'Roll back', exact: true }).click()
    await expect(drawer.getByText('Rolled back', { exact: false }).first()).toBeVisible()
    await page.goto('/banking')
    await expect(page.locator('main').getByText('Module rendered 1.0.0', { exact: true })).toBeVisible()
  } finally {
    try { await page.request.post('/api/admin/modules', { data: { action: 'deactivate', key, reason: 'Browser verification cleanup' }, headers: { Origin: new URL(baseURL!).origin } }) } finally { await context.close() }
  }
})
