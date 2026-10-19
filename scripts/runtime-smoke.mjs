import './runtime-smoke-network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PubSub } from '@google-cloud/pubsub';
import { createMockBackend } from '../examples/mock-backend.mjs';
import { checkEmulator, createHarness, emulatorHost } from './runtime-smoke-support.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const streamer = 'runtime-smoke-streamer';
const session = 'runtime-smoke-session';
const renderToken = 'runtime-smoke-token';
const sharedSecret = 'runtime-smoke-secret';
const sourceUrl = 'https://example.invalid/source/runtime-smoke';

async function main() {
  const firestoreHost = emulatorHost('FIRESTORE_EMULATOR_HOST');
  const pubsubHost = emulatorHost('PUBSUB_EMULATOR_HOST');
  await access(join(root, 'dist/server.js')).catch(() => {
    throw new Error('dist/server.js is missing; run npm run build before test:runtime');
  });
  await Promise.all([
    checkEmulator('FIRESTORE_EMULATOR_HOST', firestoreHost),
    checkEmulator('PUBSUB_EMULATOR_HOST', pubsubHost),
  ]);
  const { DistributedLockService } = await import('../dist/services/distributed-lock-service.js');
  const id = `runtime-smoke-${randomUUID().slice(0, 8)}`;
  const projectId = id;
  const cwd = await mkdtemp(join(tmpdir(), 'reader-runtime-smoke-'));
  const env = {
    PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, NODE_ENV: 'test',
    METADATA_SERVER_DETECTION: 'none', CLOUDSDK_CONFIG: cwd,
    GOOGLE_APPLICATION_CREDENTIALS: '', google_application_credentials: '',
    FIRESTORE_EMULATOR_HOST: firestoreHost, PUBSUB_EMULATOR_HOST: pubsubHost,
    GCP_PROJECT_ID: projectId, INSTANCE_ID: id, FIRESTORE_LOCK_COLLECTION: `${id}-locks`,
    PUBSUB_TOPIC_NAME: `${id}-events`, PUBSUB_SUBSCRIPTION_NAME: `${id}-sub`,
    PUBSUB_DELETE_SUBSCRIPTION_ON_CLOSE: 'true',
    TIKTOK_READER_SHARED_SECRET: sharedSecret, BACKEND_INGRESS_TOKEN: 'runtime-smoke-ingress',
    TIKTOK_EULER_API_KEY: '', TIKTOK_READER_RATE_LIMIT_ENABLED: 'false',
    SOURCE_COMMIT: 'runtime-smoke', TIKTOK_READER_SOURCE_URL: sourceUrl,
  };
  // Fixture SDK clients must not consult the caller's ADC files or metadata service either.
  for (const name of ['CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'google_application_credentials', 'METADATA_SERVER_DETECTION']) {
    process.env[name] = env[name];
  }
  const harness = createHarness(root, cwd, env);
  const { server: backend, received } = createMockBackend({
    ingressToken: env.BACKEND_INGRESS_TOKEN,
    sessions: { [session]: { renderToken, liveUrl: `https://www.tiktok.com/@${streamer}/live` } },
  });
  // This lease outlives the entire smoke and keeps the real reader off the TikTok upstream.
  const leader = new DistributedLockService(projectId, env.FIRESTORE_LOCK_COLLECTION, `${id}-fixture`, { leaseDurationMs: 300_000 });
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(env.PUBSUB_TOPIC_NAME);
  const cleanupErrors = [];
  let failed;
  let backendPosts = 0;
  let leaseAcquisition;
  let topicCreation;
  const watchdog = setTimeout(() => {
    console.error('Runtime smoke exceeded its 120 second deadline');
    process.kill(process.pid, 'SIGTERM');
  }, 120_000);
  try {
    backend.on('error', error => { failed ??= error; });
    backend.on('request', request => { if (request.method === 'POST') backendPosts++; });
    backend.listen(0, '127.0.0.1');
    await harness.wait(once(backend, 'listening'), 'mock backend startup');
    await harness.wait(leader.waitForReady(), 'Firestore emulator readiness');
    leaseAcquisition = leader.acquireLock(streamer);
    assert.equal(await harness.wait(leaseAcquisition, 'fixture leader lease'), true);
    topicCreation = topic.create();
    await harness.wait(topicCreation, 'Pub/Sub emulator topic');

    const standalone = await harness.startReader('standalone', '');
    assert.equal((await harness.json(`${standalone.url}/health`)).status, 'ok');
    assert.equal((await harness.json(`${standalone.url}/ready`)).status, 'ready');
    assert.deepEqual(await harness.json(`${standalone.url}/source`), {
      license: 'AGPL-3.0-only', version: 'runtime-smoke', sourceUrl,
    });
    await harness.unauthorized(standalone.wsUrl);
    const protocols = ['ai-liver-render-v1', `ai-liver-render-token.${renderToken}`];
    const renderUrl = reader => `${reader.wsUrl}?session_id=${session}`;
    await harness.unauthorized(renderUrl(standalone), protocols);
    const shared = await harness.connect(standalone.wsUrl, [], { headers: { 'X-Reader-Secret': sharedSecret } });
    shared.ws.send(JSON.stringify({ type: 'connect', liveUrl: '', sessionId: '' }));
    await shared.message(message => message.data?.code === 'INVALID_URL');
    await shared.close();
    await harness.stopReader(standalone);
    console.log('PASS standalone: health/readiness/source, shared secret, invalid input, render fail-closed, SIGTERM');

    const reader = await harness.startReader('with-backend', `http://127.0.0.1:${backend.address().port}/api/v1`);
    for (const [sessionId, username, expected] of [
      ['wrong-session', streamer, 'SESSION_MISMATCH'],
      [session, 'wrong-streamer', 'STREAMER_NOT_ALLOWED'],
    ]) {
      const connection = await harness.connect(renderUrl(reader), protocols);
      connection.ws.send(JSON.stringify({ type: 'connect', sessionId, liveUrl: `https://www.tiktok.com/@${username}/live` }));
      await connection.message(message => message.data?.code === expected);
      assert.equal((await harness.wait(connection.closed, expected)).code, 1008);
    }
    const connection = await harness.connect(renderUrl(reader), protocols);
    connection.ws.send(JSON.stringify({ type: 'connect', sessionId: session, liveUrl: `https://www.tiktok.com/@${streamer}/live` }));
    await connection.message(message => message.type === 'status' && message.data?.status === 'connected');
    const status = await harness.json(`${reader.url}/status`);
    assert.equal(status.leaders, 0);
    assert.equal(status.clients, 1);
    const data = { id: 'runtime-smoke-comment', text: 'synthetic comment', platform: 'tiktok' };
    await harness.wait(topic.publishMessage({ data: Buffer.from(JSON.stringify({
      type: 'comment', username: streamer, data, timestamp: new Date().toISOString(), instanceId: `${id}-fixture`,
    })) }), 'publish synthetic comment');
    assert.deepEqual(await connection.message(message => message.type === 'comment'), { type: 'comment', data });
    assert.equal(received.length, 0, 'follower delivery must not forward events to the mock backend');
    await connection.close();
    await harness.stopReader(reader);
    assert.equal(backendPosts, 0, 'follower must not POST to the mock backend, including during shutdown');
    assert.equal(received.length, 0, 'follower must not forward events after WebSocket delivery');
    harness.check();
    if (failed) throw failed;
    console.log('PASS mock backend: render auth, session/streamer rejection, follower Pub/Sub → WebSocket, SIGTERM');
  } catch (error) {
    failed = error;
  } finally {
    clearTimeout(watchdog);
    const clean = async (label, operation, timeoutMs = 15_000) => {
      try { await harness.wait(operation(), label, timeoutMs, true); }
      catch (error) { cleanupErrors.push(error); }
    };
    await clean('reader cleanup', () => harness.cleanup(), 35_000);
    for (const name of ['standalone', 'with-backend']) {
      await clean('subscription cleanup', async () => {
        try { await pubsub.subscription(`${env.PUBSUB_SUBSCRIPTION_NAME}-${id}-${name}`).delete(); }
        catch (error) { if (error.code !== 5) throw error; }
      });
    }
    if (leaseAcquisition) await clean('lease cleanup', async () => {
      if (await leaseAcquisition) assert.equal(await leader.releaseLock(streamer), true);
    });
    await clean('Firestore client cleanup', () => leader.close());
    if (topicCreation) await clean('topic cleanup', async () => {
      const [creation] = await Promise.allSettled([topicCreation]);
      try { await topic.delete(); }
      catch (error) { if (error.code !== 5) throw error; }
      if (creation.status === 'rejected') throw creation.reason;
    });
    await clean('Pub/Sub client cleanup', () => pubsub.close());
    await clean('mock backend cleanup', () => new Promise((resolve, reject) => {
      backend.closeAllConnections();
      backend.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }));
    await clean('temporary directory cleanup', () => rm(cwd, { recursive: true, force: true }));
  }
  if (failed || cleanupErrors.length) {
    harness.printLogs();
    throw new AggregateError([failed, ...cleanupErrors].filter(Boolean), 'Runtime smoke failed');
  }
}

main().catch(error => {
  console.error(error);
  // A failed emulator RPC can keep gRPC retry timers alive after bounded cleanup.
  process.exit(1);
});
