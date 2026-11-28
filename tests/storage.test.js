'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, appliedMigrations } = require('../packages/storage/db');
const {
  createSession,
  getSession,
  pruneSessions,
  deleteSession,
  insertJob,
  getJobsWithTracks,
  getJob,
  refreshJob,
  findDuplicate,
  retryJob,
  removeJob,
  expiredJobs,
  deleteExpiredJob
} = require('../packages/storage');
const { createSigner } = require('../packages/platform/signing');

function seed(
  db,
  userId,
  { id = 'job_11111111-1111-1111-1111-111111111111', playlistKey = 'pl:PL1', count = 2 } = {}
) {
  insertJob(
    db,
    {
      id,
      userId,
      sourceUrl: 'https://www.youtube.com/playlist?list=PL1',
      playlistKey,
      playlistId: 'PL1',
      title: 'Test playlist',
      thumb: null,
      folderName: 'Test playlist',
      status: 'queued',
      single: false,
      isVideo: false,
      format: 'mp3',
      collection: '',
      createdAt: new Date().toISOString()
    },
    Array.from({ length: count }, (_, i) => ({
      id: `trk_${String(i).padStart(8, '0')}-1111-1111-1111-111111111111`,
      index: i + 1,
      videoId: `vid${i}0000000`.slice(0, 11),
      title: `Track ${i + 1}`,
      artist: 'Artist',
      album: 'Album'
    }))
  );
  return id;
}

test('migrations are idempotent and tracked', () => {
  const db = openDatabase(':memory:');
  const first = appliedMigrations(db);
  assert.equal(first.length, 1);
  const { migrate } = require('../packages/storage/db');
  migrate(db);
  assert.deepEqual(appliedMigrations(db), first);
  db.close();
});

test('session tokens are stored as hashes and expire', () => {
  const db = openDatabase(':memory:');
  const created = createSession(db, { ttlMs: 60_000 });
  assert.ok(created.token.length > 30);
  const row = db.prepare('SELECT * FROM sessions').get();
  assert.notEqual(row.token_hash, created.token);
  assert.equal(row.csrf_token, created.csrfToken);

  const found = getSession(db, created.token);
  assert.equal(found.userId, created.userId);

  db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(getSession(db, created.token), null);
  assert.equal(pruneSessions(db), 0);
  assert.equal(deleteSession(db, created.token), false);
  db.close();
});

test('sessions are isolated by user and prune handles stale rows', () => {
  const db = openDatabase(':memory:');
  const a = createSession(db, { ttlMs: 60_000 });
  const b = createSession(db, { ttlMs: 60_000 });
  seed(db, a.userId);
  assert.equal(getJobsWithTracks(db, a.userId).length, 1);
  assert.equal(getJobsWithTracks(db, b.userId).length, 0);
  assert.equal(getJob(db, b.userId, 'job_11111111-1111-1111-1111-111111111111'), null);

  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    b.userId
  );
  assert.equal(pruneSessions(db), 1);
  db.close();
});

test('job lifecycle, duplicate detection, retry and removal', () => {
  const db = openDatabase(':memory:');
  const user = createSession(db, { ttlMs: 60_000 }).userId;
  const jobId = seed(db, user);
  assert.ok(findDuplicate(db, user, 'pl:PL1'));
  assert.equal(findDuplicate(db, user, 'pl:OTHER'), null);

  const row = getJob(db, user, jobId);
  assert.equal(row.tracks.length, 2);
  const refreshed = refreshJob(db, jobId, 24 * 60 * 60 * 1000);
  assert.equal(refreshed.status, 'queued');

  db.prepare("UPDATE tracks SET status = 'failed' WHERE job_id = ?").run(jobId);
  refreshJob(db, jobId, 24 * 60 * 60 * 1000);
  assert.equal(retryJob(db, user, jobId), 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE job_id = ? AND status = 'queued'").get(jobId).n,
    2
  );

  db.prepare("UPDATE tracks SET status = 'done'").run();
  const done = refreshJob(db, jobId, 1000);
  assert.equal(done.status, 'done');
  assert.ok(done.expires_at);

  db.prepare('UPDATE jobs SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(expiredJobs(db).length, 1);
  assert.equal(deleteExpiredJob(db, user, jobId), true);
  assert.equal(getJob(db, user, jobId), null);
  db.close();
});

test('removeJob refuses active work', () => {
  const db = openDatabase(':memory:');
  const user = createSession(db, { ttlMs: 60_000 }).userId;
  const jobId = seed(db, user);
  assert.equal(removeJob(db, user, jobId), 'running');
  db.prepare("UPDATE tracks SET status = 'done'").run();
  assert.equal(removeJob(db, user, jobId), 'removed');
  db.close();
});

test('signed download tokens reject tampering and expiry', async () => {
  const signer = createSigner('0123456789abcdef0123456789abcdef');
  const token = signer.sign({ u: 'usr_1', j: 'job_1', t: 'trk_1' }, 1000);
  assert.deepEqual(signer.verify(token).t, 'trk_1');
  assert.equal(signer.verify(`${token}x`), null);
  // Flip a character well inside the token: the final base64url character can
  // carry padding bits, so changing it does not always change the signature.
  const tampered = `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`;
  assert.equal(signer.verify(tampered), null);
  const short = signer.sign({ u: 'usr_1' }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signer.verify(short), null);
});

test('files outside the user root are rejected', () => {
  const { createFileStore } = require('../packages/storage/files');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagly-files-'));
  try {
    const store = createFileStore({ downloadDir: dir });
    const contained = store.trackFile('usr_aaaaaaaa', 'job_bbbbbbbb', '../escape.mp3');
    assert.equal(path.basename(contained), 'escape.mp3');
    assert.ok(contained.startsWith(store.jobDir('usr_aaaaaaaa', 'job_bbbbbbbb')));
    assert.throws(() => store.trackFile('usr_../../x', 'job_bbbbbbbb', 'ok.mp3'));
    assert.throws(() => store.trackFile('usr_aaaaaaaa', 'job_../../x', 'ok.mp3'));
    assert.throws(() => store.trackFile('usr_aaaaaaaa', 'job_bbbbbbbb', 'notes.txt'));
    assert.equal(store.filename('A/B:C*D', 1, '.mp3'), '01 - ABCD.mp3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
