import { expect, test } from '@playwright/test'
import { authedContext } from './auth'

test('Insight cards and dashboards remain editable after publishing', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await authedContext(browser, baseURL)
  // Use the browser transport: production sessions are Secure cookies, and
  // Chromium's loopback handling differs from APIRequestContext over HTTP.
  async function mutate(path: string, method: 'POST' | 'DELETE') {
    const result = await page.evaluate(
      async ({ path, method }) => {
        const response = await fetch(path, { method })
        return { status: response.status, text: await response.text() }
      },
      { path, method },
    )
    return {
      ok: () => result.status >= 200 && result.status < 300,
      text: async () => result.text,
      json: async () => JSON.parse(result.text),
    }
  }
  const created: string[] = []
  try {
    await page.goto('/insights')
    // A fresh CI company still has its first-run overlay. Defer setup through
    // the real UI before exercising controls underneath it.
    const wizard = page.getByTestId('setup-wizard')
    if (await wizard.isVisible()) {
      const [deferred] = await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith('/api/admin/setup/wizard') &&
          response.request().method() === 'POST',
        ),
        wizard.getByRole('button', { name: 'Skip for now', exact: true }).click(),
      ])
      expect(deferred.status(), await deferred.text()).toBe(200)
      await expect(wizard).toBeHidden()
    }
    const cardResponse = await mutate('/api/insights/cards/draft', 'POST')
    expect(cardResponse.ok(), await cardResponse.text()).toBe(true)
    const card = await cardResponse.json()
    created.push(`/api/insights/cards/${card.id}`)
    const preview = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/insights/query') &&
        response.request().method() === 'POST',
    )
    await page.goto(`/insights?card=${card.id}`)
    const queryResponse = await preview
    expect(queryResponse.status(), await queryResponse.text()).toBe(200)

    async function editAndPublish(
      path: string,
      placeholder: string,
      name: string,
    ) {
      const nameInput = page.getByPlaceholder(placeholder, { exact: true }).filter({ visible: true })
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith(path) &&
          response.request().method() === 'PATCH',
      )
      await nameInput.fill(name)
      const saveResponse = await saved
      expect(saveResponse.status(), await saveResponse.text()).toBe(200)
      const before = await saveResponse.json()
      expect(before.updated_at).toMatch(/\.\d{6}Z$/)
      const published = page.waitForResponse((response) =>
        response.url().endsWith(`${path}/publish`),
      )
      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      const publishResponse = await published
      expect(publishResponse.status(), await publishResponse.text()).toBe(200)
      const publication = await publishResponse.json()
      expect(publication.updated_at).toMatch(/\.\d{6}Z$/)
      expect(publication.updated_at).not.toBe(before.updated_at)
      await expect(
        page.getByRole('button', { name: 'Unpublish', exact: true }),
      ).toBeVisible()
      const edited = page.waitForResponse(
        (response) =>
          response.url().endsWith(path) &&
          response.request().method() === 'PATCH',
      )
      await nameInput.fill(`${name} revised`)
      const editResponse = await edited
      expect(editResponse.status(), await editResponse.text()).toBe(200)
      expect((await editResponse.json()).name).toBe(`${name} revised`)
    }

    await editAndPublish(
      created[0]!,
      'Monthly spend by department',
      'Browser regression card',
    )
    const boardResponse = await mutate('/api/insights/dashboards/draft', 'POST')
    expect(boardResponse.ok(), await boardResponse.text()).toBe(true)
    const board = await boardResponse.json()
    created.push(`/api/insights/dashboards/${board.id}`)
    await page.goto(`/insights/dashboards/${board.id}`)
    await editAndPublish(
      created[1]!,
      'Executive overview',
      'Browser regression board',
    )
  } finally {
    try {
      for (const path of created.reverse()) {
        const response = await mutate(path, 'DELETE')
        expect(response.ok(), await response.text()).toBe(true)
      }
    } finally {
      await context.close()
    }
  }
})
