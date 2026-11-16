// Focused window-control state regressions — pure, no browser required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLauncherVisible, isPanelVisible, reduceWindowState as reduce,
} from '../../lib/standalone/ai-assistant-window-state.ts';

test('minimize collapses to the launcher and keeps the chat state', () => {
  assert.equal(reduce('normal', 'minimize'), 'minimized');
  assert.equal(reduce('maximized', 'minimize'), 'minimized');
  assert.equal(isPanelVisible('minimized'), false);
  assert.equal(isLauncherVisible('minimized'), true);
  assert.equal(reduce('minimized', 'open'), 'normal');
  assert.equal(reduce('minimized', 'restore'), 'normal');
});

test('maximize and restore are symmetric and only work on a visible panel', () => {
  assert.equal(reduce('normal', 'toggleMaximize'), 'maximized');
  assert.equal(reduce('maximized', 'toggleMaximize'), 'normal');
  assert.equal(isPanelVisible('maximized'), true);
  assert.equal(isLauncherVisible('maximized'), false);
  assert.equal(reduce('minimized', 'toggleMaximize'), 'minimized');
  assert.equal(reduce('closed', 'toggleMaximize'), 'closed');
});

test('close hides the panel but the launcher always reopens it', () => {
  assert.equal(reduce('maximized', 'close'), 'closed');
  assert.equal(isPanelVisible('closed'), false);
  assert.equal(isLauncherVisible('closed'), true);
  assert.equal(reduce('closed', 'open'), 'normal');
  assert.equal(reduce('closed', 'minimize'), 'closed');
});

test('window controls never encode navigation or a write action', () => {
  for (const action of ['open', 'minimize', 'toggleMaximize', 'close', 'restore']) {
    const next = reduce('normal', action);
    assert.ok(['closed', 'normal', 'maximized', 'minimized'].includes(next));
  }
});
