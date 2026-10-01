import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import { NAV_MODULES, NAV_GROUPS } from './registry'
import { LOCAL_NAVIGATION } from '@openbooks/engine/src/navigation/local-navigation.ts'

const locales = ['en', 'fr', 'es', 'de', 'pt-BR', 'zh', 'ja']
const read = (locale: string, namespace: string) => JSON.parse(readFileSync(new URL(`../../messages/${locale}/${namespace === 'continuousClose' ? 'continuous-close' : namespace}.json`, import.meta.url), 'utf8')) as Record<string, Record<string, string>>

for (const locale of locales) {
  test(`${locale}: every menu, section, workspace and new UI label resolves through its catalog`, () => {
    const nav = read(locale, 'nav')
    const translate = createTranslator({ locale, messages: nav })
    for (const module of NAV_MODULES) {
      assert.ok(nav.modules?.[module.key], `nav.modules.${module.key}`)
      assert.ok(!translate(`modules.${module.key}` as never).includes('nav.'), module.key)
      if (module.subgroup) assert.ok(nav.groups?.[module.subgroup.toLowerCase()], `nav.groups.${module.subgroup.toLowerCase()}`)
    }
    for (const group of NAV_GROUPS) assert.ok(nav.groups?.[group.key], `nav.groups.${group.key}`)
    for (const set of LOCAL_NAVIGATION) {
      assert.ok(nav.localWorkspaces?.[set.id], `nav.localWorkspaces.${set.id}`)
      for (const tab of set.tabs) {
        const catalog = read(locale, tab.ns)
        const value = tab.key.split('.').reduce<unknown>((current, key) => typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined, catalog)
        assert.equal(typeof value, 'string', `${locale}: ${tab.ns}.${tab.key}`)
      }
    }
    const admin = read(locale, 'admin')
    for (const key of ['workspaceHelp', 'localTitle', 'localHelp', 'localWorkspace', 'localLabel', 'resetLocal']) assert.ok(admin.navigation?.[key], `admin.navigation.${key}`)
    assert.equal(typeof read(locale, 'shell').localNavigation, 'string')
    assert.equal(typeof read(locale, 'shell').topNav!.openMenu, 'string')
    assert.ok(read(locale, 'dashboard').header?.description)
  })
}
