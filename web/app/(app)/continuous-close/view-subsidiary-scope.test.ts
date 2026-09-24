import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const denied = { kind: 'notFound' }
Object.assign(globalThis, { __continuousCloseScopeTest: { allowedSubsidiaryIds: new Set(['sub-a']) }, __continuousCloseDenied: denied })
const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return virtual('export {}')
  if (specifier === 'next/navigation') return virtual('export function notFound(){ throw globalThis.__continuousCloseDenied }; export function redirect(){}')
  if (specifier === 'next-intl/server') return virtual("export async function getTranslations(){return (key)=>key}; export async function getLocale(){return 'en'}")
  if (specifier.endsWith('/lib/money-server') && (context.parentURL ?? '').includes('/continuous-close/view.ts')) return virtual('export async function getMoneyFormatter(){return {money:String}}')
  if (specifier.endsWith('/lib/authz') && (context.parentURL ?? '').includes('/continuous-close/view.ts')) return virtual('export async function requirePermission(){return { user:{orgId:"org-a",id:"user-a"}, allowedSubsidiaryIds:globalThis.__continuousCloseScopeTest.allowedSubsidiaryIds, permissions:new Set(["assistant.use"]) }}; export function can(){return false}')
  return next(specifier, context)
} })

const { loadContinuousClose } = await import('./view')

test('continuous-close refuses restricted readers before loading org-wide findings and report narratives', async () => {
  await assert.rejects(loadContinuousClose({}), (error) => error === denied)
})
