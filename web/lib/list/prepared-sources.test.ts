import assert from 'node:assert/strict'
import test from 'node:test'
import { registeredListTable } from './prepared-spec'
import {
  preparedListSource,
  preparedListSources,
  preparedPageState,
} from './prepared-sources'
import { field, column, text } from '@braedonsaunders/appkit-viewspec'

test('unknown sources refuse rather than adopting a loaded-list fallback', () => {
  assert.throws(
    () => preparedListSource('missing_source'),
    /Unregistered record list source: missing_source/,
  )
})

test('every server list declares the complete pagination contract', () => {
  for (const [key, source] of Object.entries(preparedListSources())) {
    assert.ok(source.route.startsWith('/'), key)
    if (source.mode !== 'server') continue
    assert.ok(source.rowsField && source.rowKeyField && source.paging, key)
    assert.ok(
      source.paging.totalField &&
        source.paging.pageField &&
        source.paging.perPageField,
      key,
    )
  }
})

test('pagination accepts zero totals and refuses missing or invalid fields by name', () => {
  const source = preparedListSource('admin_api_keys')
  assert.deepEqual(
    preparedPageState(source, { total: 0, currentPage: 1, perPage: 25 }),
    { total: 0, page: 1, perPage: 25 },
  )
  for (const value of [undefined, -1, 1.5, Infinity, NaN, '25']) {
    assert.throws(
      () =>
        preparedPageState(source, {
          total: 50,
          currentPage: 1,
          perPage: value,
        }),
      /Invalid record-list pagination field: perPage/,
    )
  }
  assert.throws(
    () => preparedPageState(source, { total: 50, perPage: 25 }),
    /currentPage/,
  )
})

test('independent list tabs retain their own server counts', () => {
  const scope = { totalForms: 30, totalViews: 70, currentPage: 2, perPage: 25 }
  assert.equal(
    preparedPageState(
      preparedListSource('admin_customization_form_rows'),
      scope,
    ).total,
    30,
  )
  assert.equal(
    preparedPageState(
      preparedListSource('admin_customization_view_rows'),
      scope,
    ).total,
    70,
  )
})

test('registered descriptors preserve typed cells and stable row identity', () => {
  const list = registeredListTable('data_import_history', {
    rows: field('rows'),
    rowKey: field('id'),
    columns: [column('Name', text(field('name')))],
    variant: 'app',
  })
  assert.equal(list.widget, 'registered-record-list')
  assert.equal(list.props?.source, 'data_import_history')
  const table = list.props?.table as { rows: unknown; rowKey: unknown }
  assert.deepEqual(table.rows, field('rows'))
  assert.deepEqual(table.rowKey, field('id'))
})

test('Talent worklists retain record identities when the first saved row appears',()=>{
 for(const key of ['hrm_goal_worklist','hrm_review_template_documents','hrm_review_worklist','hrm_application_worklist']){
  const source=preparedListSource(key);assert.equal(source.mode,'loaded',key);assert.equal(source.rowKeyField,'id',key);
 }
});
