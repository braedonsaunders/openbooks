/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { anchoredMenuPosition } from './anchored-menu-position';

test('a menu near the bottom opens fully above its trigger', () => {
  const anchor = { top: 690, bottom: 730, left: 100, width: 250 };
  const menu = anchoredMenuPosition(anchor, { width: 1280, height: 768 }, 160);
  assert.equal(menu.top + 160, anchor.top - 6);
  assert.equal(menu.left, anchor.left);
});
test('a small menu stays below when the available space fits it', () => {
  const anchor = { top: 550, bottom: 590, left: 100, width: 250 };
  const menu = anchoredMenuPosition(anchor, { width: 1280, height: 768 }, 100);
  assert.equal(menu.top, anchor.bottom + 6);
});
test('a menu near the right edge clamps its minimum width inside the viewport', () => {
  const menu = anchoredMenuPosition({ top: 50, bottom: 90, left: 1220, width: 50 }, { width: 1280, height: 768 }, 180);
  assert.equal(menu.width, 208);
  assert.ok(menu.left + menu.width <= 1280 - 8);
});
test('oversized content is constrained to the larger available side', () => {
  const menu = anchoredMenuPosition({ top: 500, bottom: 540, left: 100, width: 250 }, { width: 1280, height: 768 }, 2000);
  assert.equal(menu.top, 8);
  assert.equal(menu.maxHeight, 486);
});
test('menus remain inside small, resized and offscreen-anchor viewports', () => {
  for (const width of [16, 200, 1024, 1920]) for (const height of [16, 100, 300, 768]) {
    for (const top of [-500, 0, height / 2, height - 20, height + 100]) for (const left of [-400, 0, width - 30, width + 100]) {
      for (const desired of [0, 44, 180, 4000]) {
        const menu = anchoredMenuPosition({ top, bottom: top + 40, left, width: 450 }, { width, height }, desired);
        assert.ok(menu.top >= 0 && menu.left >= 0 && menu.width >= 0 && menu.maxHeight >= 0);
        assert.ok(menu.left + menu.width <= width);
        assert.ok(menu.top + Math.min(desired, menu.maxHeight) <= height);
      }
    }
  }
});
