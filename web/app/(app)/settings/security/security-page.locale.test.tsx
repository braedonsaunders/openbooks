import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
Object.assign(globalThis, { React })
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {push(){}}}',
      }
    }
    return next(specifier, context)
  },
})
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const frenchMessages = (await import('../../../../messages/fr')).default
const [{ SecurityPageContent }, { jsonRequest }] = await Promise.all([import('./sections'), import('./security-panel')])

test('security settings page renders in French and uses localized request failure copy', async () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={frenchMessages} timeZone="UTC">
      <SecurityPageContent />
    </NextIntlClientProvider>,
  )

  assert.match(markup, /Sécurité de connexion/)
  assert.match(markup, /Authentification multifacteur/)
  // Pre-load the panel asserts no MFA state: the setup action appears only
  // after the fetch resolves, so a slow load never reads as MFA-disabled.
  assert.match(markup, /Chargement…/)
  assert.match(markup, /Sessions actives/)
  assert.match(markup, /Révoquez une session de navigateur sans changer votre mot de passe/)
  assert.doesNotMatch(markup, /Sign-in security|Authenticator MFA|Set up authenticator|Active sessions|Revoke a browser session/)
  assert.doesNotMatch(markup, /Configurer l’authentificateur/)
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(jsonRequest('/api/auth/mfa', {}, frenchMessages.shell.securityPage.requestFailed), { message: frenchMessages.shell.securityPage.requestFailed })
})
