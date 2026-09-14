import { expect, test } from '@playwright/test'
import { authedContext, dismissSetupWizard } from './auth'

test('agent draft previews without installation and activates once in the unified inventory', async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL)
  const key = `extension-browser-${Date.now()}`
  const headers = { Origin: new URL(baseURL!).origin }
  const bundle = {
    manifest: { key, name: 'Inspection workspace proof', version: '1.0.0', permissions: ['records.read', 'records.create'], frontend: { renderer: 'native', entry: 'frontend/ui.json' }, endpoints: [{ name: 'create-check', file: 'backend/create-check.js', method: 'POST' }] },
    files: [
      { path: 'frontend/ui.json', content: JSON.stringify({ screens: [
        { key: 'overview', title: 'Overview', kind: 'page', spec: { specVersion: 1, layout: 'list', header: [{ kind: 'page-header', title: 'Inspection workspace proof' }], body: [{ kind: 'text', content: 'Native extension preview proof' }] } },
        { key: 'checks', title: 'Checks', kind: 'records', typeKey: key },
        { key: 'create', title: 'Record inspection', kind: 'action', endpoint: 'create-check', submitLabel: 'Record inspection', fields: [{ id: 'details', fields: [{ id: 'equipment', type: 'text', label: 'Equipment', required: true }] }] },
      ] }) },
      { path: 'backend/create-check.js', content: `function handler(request) { var record = ob.platform.create('${key}', {data: request.body.input, status: 'active'}); ob.storage.set('last-check', record.record.id); return {message: 'Inspection recorded'}; }` },
      { path: 'objects/checks.json', content: JSON.stringify({ type: 'record_type', key, name: 'Inspection proof', pluralName: 'Inspection proofs', fields: [{ id: 'details', fields: [{ id: 'equipment', type: 'text', label: 'Equipment', required: true }] }] }) },
    ],
  }
  try {
    await page.goto('/admin/extensions')
    await dismissSetupWizard(page)
    await page.goto('/admin/extensions')
    const create = page.getByRole('link', { name: 'New extension', exact: true })
    await expect(create.locator('svg')).toBeVisible()
    await create.click()
    await expect(page.getByLabel('What would you like to build?')).toBeVisible()
    await expect(page.getByLabel('Module manifest', { exact: true })).toHaveCount(0)
    const prepared = await page.request.post('/api/extensions/drafts', { headers, data: { action: 'draft', bundle, reason: 'Browser proof of agent package review' } })
    expect(prepared.status(), await prepared.text()).toBe(200)
    const draft = await prepared.json()
    const absent = await page.request.get(`/api/extensions/${key}`)
    expect(absent.status()).toBe(404)
    await page.goto(draft.previewUrl)
    await expect(page.locator('main').getByText('Native extension preview proof', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Checks', exact: true }).click()
    await expect(page.locator('main').getByText('Equipment', { exact: true })).toBeVisible()
    await expect(page.locator('main').getByRole('textbox')).toHaveCount(0)
    await page.getByRole('link', { name: 'Record inspection', exact: true }).click()
    await expect(page.locator('main').getByRole('button', { name: 'Record inspection', exact: true })).toBeDisabled()
    await expect(page.locator('main').getByRole('textbox')).toHaveCount(0)
    await page.goto(draft.reviewUrl)
    const drawer = page.getByRole('dialog', { name: 'Inspection workspace proof' })
    await expect(drawer.getByRole('button', { name: 'Activate extension' })).toBeDisabled()
    await drawer.getByRole('checkbox').check()
    await drawer.getByRole('button', { name: 'Activate extension' }).click()
    await expect(page).toHaveURL(new RegExp(`extension=${key}`))
    await page.goto('/admin/extensions?q=Inspection%20workspace%20proof')
    await expect(page.locator(`main a[href*="extension=${key}"]`)).toHaveCount(1)
    await page.goto(`/admin/extensions?extension=${key}`)
    await expect(page).toHaveURL(new RegExp(`/admin/extensions\\?extension=${key}`))
    await page.goto(`/apps/${key}`)
    await expect(page.locator('main').getByText('Native extension preview proof', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Record inspection', exact: true }).click()
    await page.locator('main').getByRole('textbox').fill('Browser inspection pump')
    const action = page.waitForResponse(response => response.url().includes(`/api/extensions/${key}/actions`) && response.request().method() === 'POST')
    await page.locator('main').getByRole('button', { name: 'Record inspection', exact: true }).click()
    expect((await action).status()).toBe(200)
    await expect(page.locator('main').getByRole('status')).toHaveText('Inspection recorded')
    await page.getByRole('link', { name: 'Checks', exact: true }).click()
    await expect(page.locator('main').getByRole('heading', { name: 'Inspection proofs', exact: true })).toBeVisible()
    await expect(page.locator('main').getByText('Browser inspection pump', { exact: true })).toBeVisible()
    await page.locator('main').getByRole('row').filter({ hasText: 'Browser inspection pump' }).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/apps/${key}\\?screen=checks&rec=`))
    await expect(page.getByRole('dialog')).toBeVisible()
  } finally {
    try { await page.request.delete(`/api/extensions/${key}`, { headers }) } finally { await context.close() }
  }
})
