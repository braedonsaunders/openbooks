import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
Object.assign(globalThis, { React })
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){}}}' }
    }
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: 'data:text/javascript,export default function Link({children,...props}){return globalThis.React.createElement("a",props,children)}' }
    }
    if (specifier === './actions') {
      return { shortCircuit: true, url: 'data:text/javascript,export async function createSandboxAction(){};export async function deleteSandboxAction(){};export async function promoteSandboxAction(){return {changeSetId:"test"}};export async function refreshSandboxAction(){};export async function resetSandboxAction(){};export async function setScheduleAction(){}' }
    }
    if (specifier === '../../../../lib/sandbox-session') {
      return { shortCircuit: true, url: 'data:text/javascript,export async function enterOrg(){}' }
    }
    return next(specifier, context)
  },
})
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const frenchMessages = (await import('../../../../messages/fr')).default
const { SandboxManager } = await import('./SandboxManager')
const { BackupManager } = await import('../backups/BackupManager')

test('admin backup and sandbox controls render their French catalog copy', () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={frenchMessages} timeZone="UTC">
      <>
        <BackupManager policy={null} runs={[]} totalRuns={0} s3Enabled={false} workerOnline={false} />
        <SandboxManager sandboxes={[]} periods={[]} />
      </>
    </NextIntlClientProvider>,
  )

  assert.match(markup, /Exports restaurables/)
  assert.match(markup, /Nouvel environnement/)
  assert.match(markup, /Créer le bac à sable/)
  assert.match(markup, /Aucun environnement pour le moment/)
  assert.doesNotMatch(markup, /New environment|Create sandbox|No environments yet|Stored backups/)
})
