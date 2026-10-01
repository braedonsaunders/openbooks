import assert from 'node:assert/strict'
import test from 'node:test'

const { stubModules } = await import('../testing/stub-modules')
stubModules({ navigation: { pathname: '/data/import' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { PageHeader, PagePresentationProvider } = await import('@openbooks/ui')
const { ListPageLayout, PageContainer, WizardLayout } = await import('./page-layout')

const header = <PageHeader title="Import data" description="Preview before importing." />
const steps = [{ key: 'source', label: 'Source' }, { key: 'mapping', label: 'Map columns' }]

function embedded(children: React.ReactNode) {
  return renderToStaticMarkup(<PagePresentationProvider presentation="section">{children}</PagePresentationProvider>)
}

test('embedded wizard uses a section heading and its host scroll region while preserving progress and actions', () => {
  const html = embedded(<WizardLayout header={header} steps={steps} currentStep="source" progressLabel="Step 1 of 2"
    footer={<button>Continue</button>}><p>Upload a file</p></WizardLayout>)
  assert.match(html, /<h2[^>]*>Import data<\/h2>/)
  assert.doesNotMatch(html, /<h1|overflow-y-auto|max-w-3xl/)
  assert.match(html, /aria-current="step"/)
  assert.match(html, /Step 1 of 2/)
  assert.match(html, /Upload a file/)
  assert.match(html, /<button>Continue<\/button>/)
})

test('embedded lists and content pages keep the host spacing without nesting scroll regions', () => {
  const list = embedded(<ListPageLayout header={header}><p>History table</p></ListPageLayout>)
  assert.match(list, /<h2/)
  assert.match(list, /History table/)
  assert.doesNotMatch(list, /overflow-y-auto|max-w-screen-2xl/)
  const content = embedded(<PageContainer>{header}<p>Export fields</p></PageContainer>)
  assert.match(content, /Export fields/)
  assert.doesNotMatch(content, /overflow-y-auto|max-w-screen-2xl/)
})

test('standalone pages retain their heading, width and internal scrolling', () => {
  const html = renderToStaticMarkup(<WizardLayout header={header} steps={steps} currentStep="source"><p>Upload a file</p></WizardLayout>)
  assert.match(html, /<h1/)
  assert.match(html, /overflow-y-auto/)
  assert.match(html, /max-w-3xl/)
})
