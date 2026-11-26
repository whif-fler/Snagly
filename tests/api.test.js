'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, newSession, createJob, waitForJob, rawRequest, openSse } = require('./helpers');

function parseStoredZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, buffer.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('session bootstrap, static assets and security headers', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const home = await fetch(`${server.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /img-src 'self' data:/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  const privacy = await fetch(`${server.base}/privacy`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /privacy/i);

  const health = await fetch(`${server.base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const missing = await fetch(`${server.base}/api/jobs`);
  assert.equal(missing.status, 401);

  const session = await newSession(server.base);
  const boot = await session.json('/api/session');
  assert.equal(boot.res.status, 200);
  assert.equal(boot.data.capabilities.mode, 'cloud');
  assert.equal(boot.data.capabilities.localBrowserCookies, false);
  assert.ok(boot.data.csrfToken.length > 20);
});

test('end-to-end mocked job, signed file delivery and ZIP archive', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const session = await newSession(server.base);

  const created = await createJob(session, { format: 'mp3' });
  assert.equal(created.created.length, 1);
  assert.equal(created.created[0].trackCount, 3);
  const job = await waitForJob(session, created.created[0].id, (item) => item.status === 'done');
  assert.equal(job.done, 3);
  assert.equal(job.tracks.length, 3);
  assert.ok(job.archiveUrl);
  assert.equal(job.folder, null);
  for (const track of job.tracks) {
    assert.ok(track.filename);
    assert.equal(track.file, null);
    assert.ok(!track.filename.includes('\\'));
    assert.ok(!track.filename.includes('/'));
    assert.ok(track.downloadUrl);
  }

  const file = await fetch(`${server.base}${job.tracks[0].downloadUrl}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal((await file.arrayBuffer()).byteLength, 96 * 1024);

  const head = await fetch(`${server.base}${job.tracks[0].downloadUrl}`, {
    method: 'HEAD',
    headers: { range: 'bytes=0-9' }
  });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '10');

  const archive = await fetch(`${server.base}${job.archiveUrl}`);
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  const files = parseStoredZip(Buffer.from(await archive.arrayBuffer()));
  assert.equal(files.size, 3);
  for (const [name, content] of files) {
    assert.match(name, /\.mp3$/);
    assert.equal(content.length, 96 * 1024);
  }
});

test('one user cannot read, change or delete another user job', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const alice = await newSession(server.base);
  const bob = await newSession(server.base);
  const created = await createJob(alice);
  const jobId = created.created[0].id;
  const job = await waitForJob(alice, jobId, (item) => item.status === 'done');

  assert.equal((await bob.get(`/api/jobs/${jobId}`)).status, 404);
  assert.equal((await bob.send('DELETE', `/api/jobs/${jobId}`)).status, 404);
  assert.equal((await bob.send('POST', `/api/jobs/${jobId}/cancel`, {})).status, 404);
  assert.equal((await bob.send('POST', `/api/jobs/${jobId}/retry`, {})).status, 404);
  assert.equal(
    (await bob.send('POST', `/api/jobs/${jobId}/tracks/${job.tracks[0].id}/tags`, { tags: { title: 'x' } }))
      .status,
    404
  );

  const withCookie = await fetch(`${server.base}/api/jobs/${jobId}/files/${job.tracks[0].id}`, {
    headers: { cookie: bob.cookie }
  });
  assert.equal(withCookie.status, 404);

  const bobList = await bob.json('/api/jobs');
  assert.equal(bobList.data.jobs.length, 0);

  const aliceList = await alice.json('/api/jobs');
  assert.equal(aliceList.data.jobs.length, 1);
});

test('SSE streams are isolated per user', async (t) => {
  const server = await startTestServer();
  const alice = await newSession(server.base);
  const bob = await newSession(server.base);
  const aliceSse = await openSse(server.base, alice.cookie);
  const bobSse = await openSse(server.base, bob.cookie);
  t.after(() => {
    aliceSse.close();
    bobSse.close();
    return server.close();
  });

  const aliceInitial = await aliceSse.waitFor((event) => event.type === 'state');
  const bobInitial = await bobSse.waitFor((event) => event.type === 'state');
  assert.equal(aliceInitial.jobs.length, 0);
  assert.equal(bobInitial.jobs.length, 0);

  const created = await createJob(alice);
  const jobId = created.created[0].id;
  const update = await aliceSse.waitFor(
    (event) => event.type === 'state' && event.jobs.some((job) => job.id === jobId)
  );
  assert.ok(update);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(
    bobSse.events.every((event) => event.type !== 'state' || event.jobs.length === 0),
    'Bob received Alice jobs over SSE'
  );
  assert.equal((await bob.json('/api/jobs')).data.jobs.length, 0);
});

test('CSRF, origin, host and content-type protections', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const session = await newSession(server.base);

  const noToken = await fetch(`${server.base}/api/preview`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'] })
  });
  assert.equal(noToken.status, 403);

  const wrongOrigin = await fetch(`${server.base}/api/preview`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
      origin: 'https://evil.example'
    },
    body: JSON.stringify({ urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'] })
  });
  assert.equal(wrongOrigin.status, 403);

  const crossSite = await fetch(`${server.base}/api/preview`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
      'sec-fetch-site': 'cross-site'
    },
    body: JSON.stringify({ urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'] })
  });
  assert.equal(crossSite.status, 403);

  const wrongType = await fetch(`${server.base}/api/preview`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'content-type': 'text/plain', 'x-csrf-token': session.csrfToken },
    body: 'hello'
  });
  assert.equal(wrongType.status, 415);

  const host = await rawRequest(server.base, {
    path: '/healthz',
    headers: { host: 'evil.example' }
  });
  assert.equal(host.status, 421);

  const tooLarge = await fetch(`${server.base}/api/preview`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'x'.repeat(5000)] })
  });
  assert.equal(tooLarge.status, 413);
});

test('download links are scoped, tamper-proof and expire with the job', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const session = await newSession(server.base);
  const created = await createJob(session);
  const jobId = created.created[0].id;
  const job = await waitForJob(session, jobId, (item) => item.status === 'done');
  const track = job.tracks[0];

  const otherTrack = job.tracks[1];
  const swapped = track.downloadUrl.replace(track.id, otherTrack.id);
  assert.equal((await fetch(`${server.base}${swapped}`)).status, 403);

  const trackToken = new URL(track.downloadUrl, server.base).searchParams.get('token');
  const trackTokenOnArchive = `/api/jobs/${jobId}/archive?token=${encodeURIComponent(trackToken)}`;
  assert.equal((await fetch(`${server.base}${trackTokenOnArchive}`)).status, 403);
  const archiveToken = new URL(job.archiveUrl, server.base).searchParams.get('token');
  const archiveTokenOnFile = `/api/jobs/${jobId}/files/${track.id}?token=${encodeURIComponent(archiveToken)}`;
  assert.equal((await fetch(`${server.base}${archiveTokenOnFile}`)).status, 403);
  const tokenOnOtherJob = job.archiveUrl.replace(jobId, 'job_99999999-9999-9999-9999-999999999999');
  assert.equal((await fetch(`${server.base}${tokenOnOtherJob}`)).status, 403);

  const tampered = track.downloadUrl.replace(/token=[^&]+/, (match) => `${match.slice(0, -1)}x`);
  assert.equal((await fetch(`${server.base}${tampered}`)).status, 403);

  server.app.db
    .prepare('UPDATE jobs SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), jobId);
  assert.equal((await fetch(`${server.base}${track.downloadUrl}`)).status, 410);
  assert.equal((await fetch(`${server.base}${job.archiveUrl}`)).status, 410);
});

test('validation, SSRF rejection and cloud-only endpoint policy', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const session = await newSession(server.base);

  const badPreview = await session.post('/api/preview', {
    urls: ['https://evil.example/watch?v=dQw4w9WgXcQ']
  });
  assert.equal(badPreview.res.status, 400);
  assert.match(badPreview.data.error, /YouTube/);

  const badProbe = await session.post('/api/probe', { url: 'http://127.0.0.1:22/' });
  assert.equal(badProbe.res.status, 400);

  const ssrf = await session.get('/api/thumb?u=' + encodeURIComponent('http://127.0.0.1:8080/x.jpg'));
  assert.equal(ssrf.status, 400);
  const lookalike = await session.get(
    '/api/thumb?u=' + encodeURIComponent('https://i.ytimg.com.evil.example/x.jpg')
  );
  assert.equal(lookalike.status, 400);

  assert.equal((await session.post('/api/open', { path: 'C:\\' })).res.status, 403);
  assert.equal((await session.post('/api/browse', {})).res.status, 403);
  assert.equal((await session.post('/api/tags/edit', { file: 'x', tags: {} })).res.status, 403);

  const traversal = await fetch(`${server.base}/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 404);
  const encodedTraversal = await fetch(`${server.base}/%2e%2e%2f%2e%2e%2fpackage.json`);
  assert.equal(encodedTraversal.status, 404);

  const pollution = await fetch(`${server.base}/api/preview`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken
    },
    body: '{"urls":["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],"__proto__":{"polluted":true}}'
  });
  assert.equal(pollution.status, 200);
  assert.equal({}.polluted, undefined);

  const unknownFormat = await session.post('/api/jobs', {
    urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    format: '--exec=calc'
  });
  assert.equal(unknownFormat.res.status, 400);

  const duplicate = await session.post('/api/jobs', {
    urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    format: 'mp3'
  });
  assert.equal(duplicate.res.status, 201);
  const again = await session.post('/api/jobs', {
    urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    format: 'mp3'
  });
  assert.equal(again.res.status, 201);
  assert.equal(again.data.created.length, 0);
  assert.equal(again.data.errors[0].duplicate, true);
});

test('per-user pause, tag editing and cache clearing', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const session = await newSession(server.base);
  const created = await createJob(session);
  const job = await waitForJob(session, created.created[0].id, (item) => item.status === 'done');

  const paused = await session.post('/api/pause', { paused: true });
  assert.equal(paused.res.status, 200);
  assert.equal(paused.data.paused, true);
  await session.post('/api/pause', { paused: false });

  const tags = await session.post(`/api/jobs/${job.id}/tracks/${job.tracks[0].id}/tags`, {
    tags: { title: 'Renamed', artist: 'New artist', evil: 'x' }
  });
  assert.equal(tags.res.status, 200);
  const refreshed = await session.json(`/api/jobs/${job.id}`);
  assert.equal(refreshed.data.job.tracks[0].title, 'Renamed');
  assert.equal(refreshed.data.job.tracks[0].artist, 'New artist');

  const cache = await session.post('/api/cache/clear', {});
  assert.equal(cache.res.status, 200);
  assert.equal(typeof cache.data.removed, 'number');
});

test('session bootstrap is rate limited per client', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  let last = null;
  for (let i = 0; i < 61; i++) {
    last = await fetch(`${server.base}/api/session`);
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('tag editing rejects unsupported-only tag payloads', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const session = await newSession(server.base);
  const created = await createJob(session);
  const job = await waitForJob(session, created.created[0].id, (item) => item.status === 'done');
  const res = await session.post(`/api/jobs/${job.id}/tracks/${job.tracks[0].id}/tags`, {
    tags: { evil: 'x' }
  });
  assert.equal(res.res.status, 400);
});
