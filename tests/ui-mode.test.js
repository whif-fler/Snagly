'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { startTestServer, newSession, createJob, waitForJob } = require('./helpers');

const publicDir = path.join(__dirname, '..', 'apps', 'web', 'public');
const modeSource = fs.readFileSync(path.join(publicDir, 'ui-mode.js'), 'utf8');
const appSource = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

function loadMode() {
  const context = { window: {} };
  vm.runInNewContext(modeSource, context);
  return context.window.SnaglyMode;
}

function cloudSaveSection() {
  const start = appSource.indexOf('function renderCloudSave');
  const end = appSource.indexOf('function renderSettings');
  assert.ok(start >= 0 && end > start, 'renderCloudSave should exist');
  return appSource.slice(start, end);
}

test('cloud copy never claims nothing is uploaded; local copy does', () => {
  const mode = loadMode();
  const cloudFooter = mode.footerCopy('cloud', 24);
  const cloudEmpty = mode.emptyCopy('cloud', 24);

  assert.doesNotMatch(cloudFooter, /nothing is uploaded/i);
  assert.doesNotMatch(cloudEmpty, /nothing is uploaded/i);
  assert.match(cloudFooter, /processed on our server/i);
  assert.match(cloudFooter, /deleted after 24 hours/i);
  assert.match(cloudEmpty, /deleted after 24 hours/i);

  assert.match(mode.footerCopy('local'), /Nothing is uploaded/);
  assert.match(mode.emptyCopy('local'), /Paste a playlist/);
});

test('retention copy follows the configured retention window', async () => {
  const mode = loadMode();
  const server = await startTestServer({ SNAGLY_RETENTION_HOURS: '6' });
  try {
    const session = await newSession(server.base);
    const { res, data } = await session.json('/api/session');
    assert.equal(res.status, 200);
    assert.equal(data.retentionHours, 6);
    assert.equal(mode.retentionHours(data), 6);
    assert.match(mode.footerCopy('cloud', data.retentionHours), /deleted after 6 hours/);
    assert.match(mode.emptyCopy('cloud', data.retentionHours), /deleted after 6 hours/);
  } finally {
    await server.close();
  }
});

test('cloud mode hides the guest chip and Connections tab', () => {
  const mode = loadMode();
  const cloudSession = { capabilities: { mode: 'cloud' } };

  assert.equal(mode.showGuestChip(cloudSession), false);
  assert.equal(mode.showConnectionsTab(cloudSession), false);
  assert.equal(mode.showGuestChip({ capabilities: { mode: 'local' } }), true);
  assert.equal(mode.showConnectionsTab({ capabilities: { mode: 'local' } }), true);

  const cloudSave = cloudSaveSection();
  assert.match(cloudSave, /ui\.connectionButton\.hidden = true/);
  assert.match(cloudSave, /ui\.connectionsTab\.hidden = true/);
});

test('folder picker is hidden in cloud without the File System Access API', () => {
  const mode = loadMode();

  assert.equal(
    mode.showFolderPicker({ mode: 'cloud', fileSystemAccess: false, directoryPicker: true }),
    false
  );
  assert.equal(
    mode.showFolderPicker({ mode: 'cloud', fileSystemAccess: true, directoryPicker: false }),
    false
  );
  assert.equal(mode.showFolderPicker({ mode: 'cloud', fileSystemAccess: true, directoryPicker: true }), true);
  assert.equal(
    mode.showFolderPicker({ mode: 'local', fileSystemAccess: false, directoryPicker: false }),
    true
  );

  assert.match(cloudSaveSection(), /ui\.saveRow\.hidden = !canPick/);
});

test('first screen keeps options behind a disclosure', () => {
  const optionsAt = indexSource.indexOf('<details class="composer-options"');
  const formatAt = indexSource.indexOf('id="formatSelect"');
  const folderAt = indexSource.indexOf('id="saveRow"');
  const chooseAt = indexSource.indexOf('id="chooseButton"');

  assert.ok(optionsAt >= 0, 'Options disclosure should exist');
  assert.ok(formatAt > optionsAt, 'format select should sit inside Options');
  assert.ok(folderAt > optionsAt, 'save folder should sit inside Options');
  assert.ok(chooseAt > optionsAt, 'Choose tracks should sit inside Options');
  assert.match(appSource, /ui\.composerOptions\.open = true/);
});

test('expiry labels use the job expiresAt and the retention window', () => {
  const mode = loadMode();
  const now = Date.parse('2026-11-28T12:00:00Z');
  const in23h = new Date(now + 23 * 3600 * 1000).toISOString();

  assert.equal(mode.expiryText(in23h, now), 'expires in 23h');
  assert.equal(mode.expiryText(new Date(now - 1000).toISOString(), now), 'expired');
  assert.equal(mode.expiredText(24), 'Removed after 24h. Paste the link again to re-download.');
  assert.doesNotMatch(indexSource, />On server</);
});

test('finished jobs expose expiresAt for the client countdown', async () => {
  const mode = loadMode();
  const server = await startTestServer();
  try {
    const session = await newSession(server.base);
    const created = await createJob(session);
    const finished = await waitForJob(session, created.created[0].id, (item) => item.status === 'done');
    assert.equal(finished.status, 'done');
    assert.ok(finished.expiresAt, 'job should expose expiresAt');
    assert.equal(finished.expired, false);
    assert.match(mode.expiryText(finished.expiresAt), /^expires in /);
  } finally {
    await server.close();
  }
});
