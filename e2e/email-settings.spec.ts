import { expect, test } from '@playwright/test'
import { authedContext } from './auth'

test('email settings echo the committed revision and refuse a stale form', async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL)
  let original: Record<string, unknown> | undefined
  const endpoint = '/api/admin/email'
  async function read() {
    return page.evaluate(async (path) => {
      const response = await fetch(path)
      if (!response.ok) throw new Error(`Email settings read failed: ${response.status}`)
      return await response.json() as Record<string, unknown>
    }, endpoint)
  }
  async function write(config: Record<string, unknown>) {
    return page.evaluate(async ({ path, config }) => {
      const response = await fetch(path, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }, { path: endpoint, config })
  }
  async function saveForm(name: string) {
    await page.getByPlaceholder('Acme Accounting', { exact: true }).fill(name)
    const response = page.waitForResponse((r) => r.url().endsWith(endpoint) && r.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    return response
  }
  try {
    await page.goto('/admin/email')
    const wizard = page.getByTestId('setup-wizard')
    if (await wizard.isVisible()) {
      await wizard.getByRole('button', { name: 'Skip for now', exact: true }).click()
      await expect(wizard).toBeHidden()
      await page.reload()
    }
    original = await read()
    const saved = await saveForm('Browser revision check')
    expect(saved.status(), await saved.text()).toBe(200)
    const current = await saved.json() as Record<string, unknown>
    expect(current.updatedAt).toMatch(/\.\d{6}Z$/)
    expect(current.updatedAt).not.toBe(original.updatedAt)
    expect(saved.request().postDataJSON().expectedUpdatedAt).toBe(original.updatedAt)

    const competing = await write({ ...current, expectedUpdatedAt: current.updatedAt, fromName: 'Concurrent administrator' })
    expect(competing.status, JSON.stringify(competing.body)).toBe(200)
    const stale = await saveForm('Stale browser edit')
    expect(stale.status()).toBe(409)
    expect((await read()).fromName).toBe('Concurrent administrator')

    await page.reload()
    const retry = await saveForm('Reviewed retry')
    expect(retry.status(), await retry.text()).toBe(200)
  } finally {
    try {
      if (original) {
        const current = await read()
        const restored = await write({ ...original, expectedUpdatedAt: current.updatedAt })
        expect(restored.status, JSON.stringify(restored.body)).toBe(200)
      }
    } finally { await context.close() }
  }
})
