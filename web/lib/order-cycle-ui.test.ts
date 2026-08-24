import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import ts from 'typescript'

const drawer = readFileSync(
  new URL('../app/(app)/_order/OrderDrawer.tsx', import.meta.url),
  'utf8',
)
const sourceFile = ts.createSourceFile(
  'OrderDrawer.tsx',
  drawer,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)
type OrderDrawerModule = typeof import('../app/(app)/_order/OrderDrawer.tsx')
const { issueSavedOrder, persistOrderDraft } = (await tsImport(
  '../app/(app)/_order/OrderDrawer.tsx',
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
  },
)) as OrderDrawerModule

function findFunction(name: string): ts.FunctionDeclaration {
  let match: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  assert.ok(match, `missing function declaration: ${name}`)
  return match
}

function calls(node: ts.Node, callee: string, firstArgument?: string): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      current.expression.getText(sourceFile) === callee &&
      (firstArgument === undefined || current.arguments[0]?.getText(sourceFile) === firstArgument)
    ) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

test('Save and Issue reuse the same draft persistence request', () => {
  const persistDraft = findFunction('persistDraft')
  const save = findFunction('save')
  const issue = findFunction('issue')

  assert.equal(calls(persistDraft, 'persistOrderDraft'), true)
  assert.equal(calls(persistDraft, 'fetch'), true)
  assert.equal(calls(save, 'persistDraft'), true)
  assert.equal(calls(save, 'fetch'), false)
  assert.equal(calls(issue, 'issueSavedOrder'), true)
  assert.equal(calls(issue, 'fetch'), false)
})

type DraftRequest = Parameters<typeof persistOrderDraft>[0]['request']

async function attemptIssue(request: DraftRequest) {
  const states: string[] = []
  const errors: Array<string | undefined> = []
  let approvalRequests = 0

  const issued = await issueSavedOrder({
    persistDraft: () =>
      persistOrderDraft({
        request,
        setState: (state) => states.push(state),
        onError: (message) => errors.push(message),
      }),
    requestApproval: async () => {
      approvalRequests += 1
    },
  })

  return { approvalRequests, errors, issued, states }
}

test('a rejected draft save sets error state and never requests approval', async () => {
  const result = await attemptIssue(async () =>
    new Response(JSON.stringify({ error: 'draft rejected' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  assert.equal(result.issued, false)
  assert.equal(result.approvalRequests, 0)
  assert.deepEqual(result.states, ['saving', 'error'])
  assert.deepEqual(result.errors, ['draft rejected'])
})

test('a thrown draft save sets error state and never requests approval', async () => {
  const result = await attemptIssue(async () => {
    throw new Error('network unavailable')
  })

  assert.equal(result.issued, false)
  assert.equal(result.approvalRequests, 0)
  assert.deepEqual(result.states, ['saving', 'error'])
  assert.deepEqual(result.errors, [undefined])
})

test('approval is requested only after draft persistence succeeds', async () => {
  const sequence: string[] = []
  const issued = await issueSavedOrder({
    persistDraft: () =>
      persistOrderDraft({
        request: async () => {
          sequence.push('save')
          return new Response(JSON.stringify({ doc: {}, lines: [], links: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        },
        setState: (state) => sequence.push(state),
        onError: () => assert.fail('successful persistence must not report an error'),
      }),
    requestApproval: async () => {
      sequence.push('approve')
    },
  })

  assert.equal(issued, true)
  assert.deepEqual(sequence, ['saving', 'save', 'saved', 'approve'])
})
