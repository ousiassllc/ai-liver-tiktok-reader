import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { blockedConnectionMarker, blockedConnections, isLoopback } from './runtime-smoke-network-guard.mjs';

export function emulatorHost(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; start a local emulator before running test:runtime`);
  const url = new URL(`http://${value}`);
  if (!isLoopback(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be a loopback host:port, such as 127.0.0.1:8080`);
  }
  return value;
}

export async function checkEmulator(name, host) {
  const url = new URL(`http://${host}`);
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    const finish = error => {
      socket.destroy();
      if (error) reject(new Error(`${name} is unreachable at ${host}`, { cause: error }));
      else resolve();
    };
    socket.setTimeout(2_000, () => finish(new Error('TCP connection timed out')));
    socket.once('error', finish);
    socket.once('connect', () => finish());
  });
}

export function createHarness(root, cwd, env) {
  const children = [];
  const sockets = new Set();
  let failure;
  const fail = (error) => { failure ??= error; };
  const onSignal = (signal) => fail(new Error(`Runtime smoke interrupted by ${signal}`));
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  function check() {
    if (failure) throw failure;
    if (blockedConnections.length) throw blockedConnections[0];
    for (const child of children) {
      if (child.blockedExternalConnection) throw new Error(`${child.name}: attempted external network connection`);
      if (child.exited && !child.stopping) throw new Error(`${child.name}: exited before shutdown (${JSON.stringify(child.result)})`);
    }
  }

  async function wait(promise, label, timeoutMs = 15_000, cleanup = false) {
    let timer;
    let interval;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timeout: ${label} (${timeoutMs} ms)`)), timeoutMs);
          if (!cleanup) interval = setInterval(() => { try { check(); } catch (error) { reject(error); } }, 50);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(interval);
    }
  }

  async function poll(test, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      check();
      const result = await test();
      if (result) return result;
      await delay(25);
    }
    throw new Error(`Timeout: ${label} (${timeoutMs} ms)`);
  }

  async function json(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200, url);
    return response.json();
  }

  async function startReader(name, backendUrl) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await wait(once(reservation, 'listening'), 'reserve reader port');
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const child = {
      name, logs: '', exited: false, stopping: false, result: null, blockedExternalConnection: false,
      url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws/events`,
      instanceId: `${env.INSTANCE_ID}-${name}`,
    };
    child.process = spawn(process.execPath, [
      '--import', join(root, 'scripts/runtime-smoke-network-guard.mjs'), join(root, 'dist/server.js'),
    ], {
      cwd, env: { ...env, PORT: String(port), INSTANCE_ID: child.instanceId, BACKEND_API_URL: backendUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const record = data => {
      const combined = child.logs + data.toString();
      child.blockedExternalConnection ||= combined.includes(blockedConnectionMarker);
      child.logs = combined.slice(-65_536);
    };
    child.process.stdout.on('data', record);
    child.process.stderr.on('data', record);
    child.process.on('error', fail);
    child.done = new Promise(resolve => child.process.once('close', (code, signal) => {
      child.exited = true;
      child.result = { code, signal };
      resolve(child.result);
    }));
    await poll(async () => {
      try { return (await fetch(`${child.url}/ready`, { signal: AbortSignal.timeout(1_000) })).status === 200; }
      catch { return false; }
    }, `${name} readiness`);
    return child;
  }

  async function connect(url, protocols = [], options = {}) {
    const ws = new WebSocket(url, protocols, { handshakeTimeout: 5_000, ...options });
    sockets.add(ws);
    const messages = [];
    let error;
    ws.on('error', value => { error = value; });
    ws.on('message', data => {
      try { messages.push(JSON.parse(data.toString())); }
      catch (value) { error = value; }
    });
    const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    await wait(once(ws, 'open'), 'WebSocket upgrade');
    return {
      ws, closed,
      async message(predicate) {
        return poll(() => {
          if (error) throw error;
          const index = messages.findIndex(predicate);
          if (index >= 0) return messages.splice(index, 1)[0];
          if (ws.readyState === WebSocket.CLOSED) throw new Error('WebSocket closed before the expected message');
          return null;
        }, 'expected WebSocket message');
      },
      async close() {
        ws.close();
        await wait(closed, 'WebSocket close');
        sockets.delete(ws);
      },
    };
  }

  async function unauthorized(url, protocols = []) {
    const ws = new WebSocket(url, protocols, { handshakeTimeout: 5_000 });
    sockets.add(ws);
    try {
      const status = await wait(new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.once('open', () => reject(new Error('Unauthenticated WebSocket was accepted')));
        ws.once('unexpected-response', (_, response) => {
          response.resume();
          resolve(response.statusCode);
        });
      }), 'unauthenticated WebSocket rejection');
      assert.equal(status, 401);
    } finally {
      ws.terminate();
      sockets.delete(ws);
    }
  }

  async function stopReader(child) {
    check();
    child.stopping = true;
    child.process.kill('SIGTERM');
    assert.deepEqual(await wait(child.done, `${child.name} graceful shutdown`), { code: 0, signal: null });
    check();
  }

  async function cleanup() {
    const errors = [];
    for (const ws of sockets) ws.terminate();
    for (const child of children) {
      if (child.exited) continue;
      child.stopping = true;
      child.process.kill('SIGTERM');
      try { await wait(child.done, `${child.name} cleanup`, 12_000, true); }
      catch (error) {
        errors.push(error);
        child.process.kill('SIGKILL');
        try { await wait(child.done, `${child.name} SIGKILL`, 3_000, true); }
        catch (killError) { errors.push(killError); }
      }
    }
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (errors.length) throw new AggregateError(errors, 'Reader process cleanup failed');
  }

  function printLogs() {
    for (const child of children) console.error(`--- ${child.name} stdout/stderr ---\n${child.logs}`);
  }

  return { check, wait, json, startReader, connect, unauthorized, stopReader, cleanup, printLogs };
}
