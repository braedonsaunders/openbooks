import { expect, test } from '@playwright/test'
import { authedContext } from './auth'

test('document drawer discards the reviewed draft with a JSON revision token', async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL)
  let id: string | undefined
  try {
    await page.goto('/ar/invoices')
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/documents/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'customer_invoice' }),
      })
      return { status: response.status, body: await response.json() }
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    id = created.body.id
    expect(id).toBeTruthy()
    await page.goto(`/ar/invoices?doc=${id}`)
    const wizard = page.getByTestId('setup-wizard')
    if (await wizard.isVisible()) {
      await wizard.getByRole('button', { name: 'Skip for now', exact: true }).click()
      await expect(wizard).toBeHidden()
      await page.waitForURL('**/admin/setup/readiness')
      await page.goto(`/ar/invoices?doc=${id}`)
    }
    await page.getByRole('button', { name: 'Actions', exact: true }).last().click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const deleted = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}`) && r.request().method() === 'DELETE')
    await page.getByRole('dialog').filter({ hasText: 'This permanently deletes the draft' }).getByRole('button', { name: 'Delete', exact: true }).click()
    const response = await deleted
    expect(response.status(), await response.text()).toBe(200)
    expect(response.request().postDataJSON().expectedUpdatedAt).toMatch(/\.\d{6}Z$/)
    id = undefined
    await expect(page).toHaveURL(/\/ar\/invoices$/)
  } finally {
    try {
      if (id) {
        await page.evaluate(async (id) => {
          const response = await fetch(`/api/documents/${id}`)
          if (!response.ok) return
          const current = await response.json()
          const removed = await fetch(`/api/documents/${id}`, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedUpdatedAt: current.doc.updated_at }),
          })
          if (!removed.ok) throw new Error(`Draft cleanup failed: ${removed.status}`)
        }, id)
      }
    } finally { await context.close() }
  }
})
