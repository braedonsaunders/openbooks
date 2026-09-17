import { expect, test } from '@playwright/test'
import { authedContext, dismissSetupWizard } from './auth'

test('agent draft previews without installation and activates once in the unified inventory', async ({ browser, baseURL }, testInfo) => {
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
    await page.goto('/admin/apps')
    await dismissSetupWizard(page)
    await page.goto('/admin/apps')
    const create = page.getByRole('link', { name: 'New app', exact: true })
    await expect(create.locator('svg')).toBeVisible()
    await create.click()
    await expect(page.getByLabel('What would you like to build?')).toBeVisible()
    await expect(page.getByLabel('Module manifest', { exact: true })).toHaveCount(0)
    const prepared = await page.request.post('/api/apps/drafts', { headers, data: { action: 'draft', bundle, reason: 'Browser proof of agent package review' } })
    expect(prepared.status(), await prepared.text()).toBe(200)
    const draft = await prepared.json()
    const absent = await page.request.get(`/api/apps/${key}`)
    expect(absent.status()).toBe(404)
    await page.goto('/admin/apps?status=pending&q=Inspection%20workspace%20proof')
    const pendingRow = page.getByRole('row').filter({ hasText: 'Inspection workspace proof' })
    await expect(pendingRow).toContainText('Pending review')
    await expect(pendingRow.getByRole('link')).toHaveAttribute('href', new RegExp(`draft=${draft.draftId}`))
    await expect(page.getByText('No apps yet.', { exact: false })).toHaveCount(0)
    await page.goto('/admin/apps?status=installed&q=Inspection%20workspace%20proof')
    await expect(page.getByRole('row').filter({ hasText: 'Inspection workspace proof' })).toHaveCount(0)
    const previewRequests: string[] = []
    const observe = (request: import('@playwright/test').Request) => {
      if (request.url().includes('/api/forms/options') || request.url().includes('/api/records/') || request.url().includes(`/api/apps/${key}/actions`)) previewRequests.push(request.url())
    }
    page.on('request', observe)
    await page.goto(draft.previewUrl)
    await expect(page.locator('main').getByText('Native extension preview proof', { exact: true })).toBeVisible()
    await expect(page.locator('main').getByRole('alert')).toHaveCount(1)
    await page.getByRole('link', { name: 'Checks', exact: true }).click()
    await expect(page.locator('main').getByRole('table')).toBeVisible()
    await expect(page.locator('main').getByRole('alert')).toHaveCount(1)
    await page.getByRole('link', { name: 'Sample 1', exact: true }).click()
    const sampleDrawer = page.getByRole('dialog')
    await sampleDrawer.getByRole('button', { name: 'Edit', exact: true }).click()
    await sampleDrawer.getByRole('textbox').fill('Local preview edit')
    await expect(sampleDrawer.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('native-record-preview.png'), fullPage: true })
    await sampleDrawer.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('link', { name: 'Record inspection', exact: true }).click()
    await page.locator('main').getByRole('button', { name: 'Record inspection', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeEditable()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Record inspection', exact: true })).toBeDisabled()
    expect(previewRequests).toEqual([])
    page.off('request', observe)
    await page.goto(draft.reviewUrl)
    const drawer = page.getByRole('dialog', { name: 'Inspection workspace proof' })
    await expect(drawer.getByRole('button', { name: 'Activate app' })).toBeDisabled()
    await expect(drawer.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => drawer.locator('footer').evaluate(footer => {
      const buttons = footer.querySelectorAll('button')
      const discard = buttons[0]!.getBoundingClientRect()
      const activate = buttons[1]!.getBoundingClientRect()
      return activate.x - discard.right
    })).toBeGreaterThanOrEqual(7)
    await page.screenshot({ path: testInfo.outputPath('draft-review.png'), fullPage: true })
    await drawer.getByRole('checkbox').check()
    await drawer.getByRole('button', { name: 'Activate app' }).click()
    await expect(page).toHaveURL(new RegExp(`app=${key}`))
    await page.goto('/admin/apps?q=Inspection%20workspace%20proof')
    await expect(page.locator(`main a[href*="app=${key}"]`)).toHaveCount(1)
    await page.goto(`/admin/apps?app=${key}`)
    await expect(page).toHaveURL(new RegExp(`/admin/apps\\?app=${key}`))
    await page.goto(`/apps/${key}`)
    await expect(page.locator('main').getByText('Native extension preview proof', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Record inspection', exact: true }).click()
    await page.locator('main').getByRole('button', { name: 'Record inspection', exact: true }).click()
    await page.getByRole('dialog').getByRole('textbox').fill('Browser inspection pump')
    const action = page.waitForResponse(response => response.url().includes(`/api/apps/${key}/actions`) && response.request().method() === 'POST')
    await page.getByRole('dialog').getByRole('button', { name: 'Record inspection', exact: true }).click()
    expect((await action).status()).toBe(200)
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Inspection recorded')
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('link', { name: 'Checks', exact: true }).click()
    await expect(page.locator('main').getByRole('heading', { name: 'Inspection proofs', exact: true })).toBeVisible()
    await expect(page.locator('main').getByText('Browser inspection pump', { exact: true })).toBeVisible()
    await page.locator('main').getByRole('row').filter({ hasText: 'Browser inspection pump' }).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/apps/${key}\\?screen=checks&rec=`))
    await expect(page.getByRole('dialog')).toBeVisible()
  } finally {
    try { await page.request.delete(`/api/apps/${key}`, { headers }) } finally { await context.close() }
  }
})

test('app management authors files, preserves drafts, exports, imports, versions and library lifecycle without an agent', async ({ browser, baseURL }, testInfo) => {
  const { context, page } = await authedContext(browser, baseURL)
  const key = `package-ui-${Date.now()}`
  const headers = { Origin: new URL(baseURL!).origin }
  try {
    await page.goto('/admin/apps')
    await dismissSetupWizard(page)
    const create = page.getByRole('link',{name:'New app',exact:true})
    const library = page.getByRole('link',{name:'App Library',exact:true})
    expect((await create.boundingBox())!.height).toBeCloseTo((await library.boundingBox())!.height, 1)
    await create.click()
    let drawer = page.getByRole('dialog',{name:'New app',exact:true})
    const brief = drawer.getByLabel('What would you like to build?')
    expect((await brief.boundingBox())!.width).toBeGreaterThan((await drawer.boundingBox())!.width * 0.8)
    await drawer.getByRole('button',{name:'HTML / CSS / JS app',exact:true}).click()
    await drawer.getByLabel('App name',{exact:true}).fill('Package editor proof')
    await drawer.getByLabel('App key',{exact:true}).fill(key)
    await drawer.getByRole('tab',{name:'Actions',exact:true}).click()
    await drawer.getByRole('button',{name:'Add action',exact:true}).click()
    await drawer.getByRole('tab',{name:'Files',exact:true}).click()
    await drawer.getByRole('button',{name:'app.js',exact:true}).click()
    await drawer.locator('.cm-content').fill('openbooks.callBackend("action-1", {}).then(result => { document.querySelector("main p").textContent = result.status === 200 && result.body.ok ? "Uploaded JavaScript runs" : "Unexpected backend result"; });')
    await drawer.getByRole('button',{name:'styles.css',exact:true}).click()
    await drawer.locator('.cm-content').fill('body { font-family: sans-serif; } h1 { color: rgb(0, 128, 128); }')
    await page.screenshot({ path: testInfo.outputPath('app-files-workspace.png'), fullPage: true })
    await drawer.getByRole('tab',{name:'General',exact:true}).click()
    await drawer.getByLabel('Reason for this version').fill('Create package through management UI')
    await drawer.getByRole('button',{name:'Save draft for review',exact:true}).click()
    await expect(page).toHaveURL(/draft=/)
    drawer = page.getByRole('dialog',{name:'Package editor proof',exact:true})
    await drawer.getByRole('tab',{name:'Package',exact:true}).click()
    await drawer.getByLabel('App name',{exact:true}).fill('Package editor reviewed')
    await drawer.getByLabel('Reason for this version').fill('Revise draft directly in the UI')
    await drawer.getByRole('button',{name:'Save draft for review',exact:true}).click()
    drawer = page.getByRole('dialog',{name:'Package editor reviewed',exact:true})
    await drawer.getByRole('checkbox',{name:'I have reviewed this version and its requested access.'}).check()
    await drawer.getByRole('button',{name:'Activate app',exact:true}).click()
    await expect(page).toHaveURL(new RegExp(`app=${key}`))
    await page.goto(`/apps/${key}`)
    const frame = page.getByRole('main').frameLocator('iframe')
    await expect(frame.locator('p')).toHaveText('Uploaded JavaScript runs')
    const appFrame = page.frames().find(value => value.url().includes('/sandbox'))!
    expect(await appFrame.evaluate(() => { try { void window.parent.document; return false } catch { return true } })).toBe(true)
    const sandbox = await page.request.get(`/api/apps/${key}/sandbox`)
    expect(sandbox.headers()['content-security-policy']).toContain('sandbox allow-scripts')
    expect(sandbox.headers()['content-security-policy']).not.toContain('allow-same-origin')
    expect(sandbox.headers()['content-security-policy']).toContain("connect-src 'none'")
    await expect(frame.locator('h1')).toHaveCSS('color','rgb(0, 128, 128)')
    await page.goto(`/admin/apps?app=${key}`)
    drawer = page.getByRole('dialog',{name:'Package editor reviewed',exact:true})
    await drawer.getByRole('tab',{name:'Versions',exact:true}).click()
    await expect(drawer.getByText('1.0.0',{exact:true})).toBeVisible()
    for (const section of ['Runs','App storage','Audit history']) {
      await drawer.getByRole('tab',{name:section,exact:true}).click()
      await expect(drawer.locator('table')).toBeVisible()
      await expect(drawer.getByRole('alert')).toHaveCount(0)
    }
    await drawer.getByRole('tab',{name:'Overview',exact:true}).click()
    await drawer.getByRole('button',{name:'Publish to App Library',exact:true}).click()
    await page.getByRole('button',{name:'Confirm',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'Unpublish listing',exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'Unpublish listing',exact:true}).click()
    await page.getByRole('button',{name:'Confirm',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'Publish to App Library',exact:true})).toBeVisible()
    const exported = await page.request.get(`/api/apps/${key}/package?download=1`)
    expect(exported.status()).toBe(200)
    const zip = await exported.body()
    await page.goto('/admin/apps?new=1')
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({name:'app.zip',mimeType:'application/zip',buffer:zip})
    await expect(page).toHaveURL(/draft=/)
    await expect(page.getByRole('tab',{name:'Package',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Discard draft',exact:true}).click()
    // F-t10-007: discard always confirms, even on an unedited imported draft.
    await page.getByRole('button',{name:'Confirm',exact:true}).click()
    await expect(page).toHaveURL('/admin/apps')
  } finally {
    try { await page.request.post('/api/apps/marketplace',{headers,data:{action:'unpublish',key}}); await page.request.delete(`/api/apps/${key}`,{headers}) } finally { await context.close() }
  }
})

test('native app authoring exposes screen and object definitions plus file operations on a narrow viewport', async ({ browser, baseURL }, testInfo) => {
  const { context, page } = await authedContext(browser, baseURL)
  const headers={Origin:new URL(baseURL!).origin}
  let draftId: string | undefined
  try {
    await page.goto('/admin/apps?new=1')
    await dismissSetupWizard(page)
    const drawer=page.getByRole('dialog',{name:'New app',exact:true})
    await drawer.getByRole('button',{name:'Native app',exact:true}).click()
    await drawer.getByLabel('App key',{exact:true}).fill(`native-ui-${Date.now()}`)
    await drawer.getByRole('tab',{name:'Screens',exact:true}).click()
    await drawer.getByLabel('New screen key').fill('summary')
    await drawer.getByRole('button',{name:'Add screen',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'Save draft for review',exact:true})).toBeDisabled()
    await drawer.getByRole('button',{name:'Open interface definition',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'Apply to draft',exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'Apply to draft',exact:true}).click()
    await expect(drawer.getByText('summary · Page',{exact:true})).toBeVisible()
    await drawer.getByRole('tab',{name:'Data & contributions',exact:true}).click()
    await drawer.getByLabel('New definition key').fill('ui-check')
    await drawer.getByRole('button',{name:'Add definition',exact:true}).click()
    await expect(drawer.getByRole('heading',{name:'objects/ui-check.json',exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'New file',exact:true}).click()
    let prompt=page.getByRole('dialog',{name:'New file',exact:true})
    await prompt.getByRole('textbox').fill('assets/notes.txt')
    await prompt.getByRole('button',{name:'Save',exact:true}).click()
    await drawer.locator('.cm-content').fill('File operations proof')
    await drawer.getByRole('button',{name:'Rename or move file',exact:true}).click()
    prompt=page.getByRole('dialog',{name:'Rename or move file',exact:true})
    await prompt.getByRole('textbox').fill('assets/moved.txt')
    await prompt.getByRole('button',{name:'Save',exact:true}).click()
    await expect(drawer.getByRole('heading',{name:'assets/moved.txt',exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'Delete file',exact:true}).click()
    await page.getByRole('button',{name:'Confirm',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'moved.txt',exact:true})).toHaveCount(0)
    await expect(page.getByRole('button',{name:'Confirm',exact:true})).toBeHidden()
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:testInfo.outputPath('app-package-mobile.png'),fullPage:true})
    expect(await drawer.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true)
    await drawer.getByLabel('Reason for this version').fill('Native screens and objects authored through UI')
    const saving=page.waitForResponse(response=>response.url().endsWith('/api/apps/drafts') && response.request().method()==='POST')
    await drawer.getByRole('button',{name:'Save draft for review',exact:true}).click()
    const response=await saving
    expect(response.status(),await response.text()).toBe(200)
    const draft=await response.json();draftId=draft.draftId
    const read=await page.request.get(`/api/apps/drafts?id=${draftId}`)
    const result=await read.json()
    expect(result.bundle.files.some((file:{path:string})=>file.path==='objects/ui-check.json')).toBe(true)
    expect(JSON.parse(result.bundle.files.find((file:{path:string})=>file.path==='frontend/ui.json').content).screens).toHaveLength(2)
    await page.request.post('/api/apps/drafts',{headers,data:{action:'discard',draftId,contentHash:draft.contentHash}})
    draftId=undefined
  } finally {
    if(draftId) { const read=await page.request.get(`/api/apps/drafts?id=${draftId}`); const draft=await read.json();await page.request.post('/api/apps/drafts',{headers,data:{action:'discard',draftId,contentHash:draft.content_hash}}) }
    await context.close()
  }
})
