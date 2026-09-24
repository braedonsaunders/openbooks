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
const { SecurityPageContent } = await import('./sections')

test('security settings page renders its heading, MFA actions, and session chrome in French', () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={frenchMessages} timeZone="UTC">
      <SecurityPageContent />
    </NextIntlClientProvider>,
  )

  assert.match(markup, /Sécurité de connexion/)
  assert.match(markup, /Authentification multifacteur/)
  assert.match(markup, /Configurer l’authentificateur/)
  assert.match(markup, /Sessions actives/)
  assert.match(markup, /Révoquez une session de navigateur sans changer votre mot de passe/)
  assert.doesNotMatch(markup, /Sign-in security|Authenticator MFA|Set up authenticator|Active sessions|Revoke a browser session/)
})
