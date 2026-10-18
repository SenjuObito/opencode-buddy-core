import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import { homedir } from 'node:os';
import {
  getServerUrl,
  getServeProcess,
  getServerPassword,
  resolveServerPassword,
  generatedPasswordPath,
  isRunning,
  findBinary,
  start,
  stop,
} from './opencode-serve-manager.js';

test('opencode-serve-manager initial state', () => {
  assert.equal(typeof getServerUrl(), 'object'); // null or string
  assert.equal(typeof isRunning(), 'boolean');
  assert.equal(getServeProcess(), null);
});

test('opencode-serve-manager findBinary resolves a binary or null', async () => {
  const bin = await findBinary();
  assert.ok(bin === null || typeof bin === 'string');
});

test('findBinary honours an explicitly passed binary (no re-scan)', async () => {
  const bin = await findBinary({ binary: '/custom/opencode' });
  assert.equal(bin, '/custom/opencode');
});

test('resolveServerPassword never throws and returns a string or null', () => {
  const value = resolveServerPassword();
  assert.ok(value === null || typeof value === 'string');
  assert.equal(getServerPassword(), value);
});

test('generatedPasswordPath follows the host-injected OPENCODEBUDDY_CONFIG_DIR', () => {
  // Both bridge processes (the long-lived daemon that spawns serve, and the
  // one-shot channel-manager that only talks to it) must agree on where the
  // generated password lives, or the second one 401s on every request. The host
  // guaranteeing a shared directory is what makes that reliable.
  const original = process.env.OPENCODEBUDDY_CONFIG_DIR;
  try {
    delete process.env.OPENCODEBUDDY_CONFIG_DIR;
    assert.equal(generatedPasswordPath(), path.join(homedir(), '.opencode-idea-gui', 'serve-password'));

    process.env.OPENCODEBUDDY_CONFIG_DIR = '/tmp/ocb-state';
    assert.equal(generatedPasswordPath(), path.join('/tmp/ocb-state', 'serve-password'));
  } finally {
    if (original === undefined) delete process.env.OPENCODEBUDDY_CONFIG_DIR;
    else process.env.OPENCODEBUDDY_CONFIG_DIR = original;
  }
});

test('start reuses an existing OPENCODE server instead of spawning a duplicate', async () => {
  // Answers the v2 capability route, i.e. it *is* an opencode server.
  const server = http.createServer((req, res) => {
    if (req.url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ apiVersion: 2 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const url = await start(port);
    assert.equal(url, `http://localhost:${port}`);
    assert.equal(getServerUrl(), `http://localhost:${port}`);
    assert.equal(getServeProcess(), null); // Reused server does not create a child process
    assert.equal(isRunning(), true); // isRunning should be true even when reused (_process is null)

    // Second call should return immediately without spawning
    const url2 = await start(port);
    assert.equal(url2, url);
    assert.equal(isRunning(), true);
  } finally {
    await stop();
    assert.equal(isRunning(), false);
    assert.equal(getServerUrl(), null);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('start does NOT adopt a non-opencode process squatting on the port', async () => {
  // A plain HTTP server (no v2 /api/info, no v1 /config) must not be treated as
  // ours. It rolls over to the next port instead — asserted here without
  // allowing a real spawn: we point `binary` at a non-existent path so the
  // spawn attempt fails loudly after the port decision was made.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello from some other app');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      () => start(port, { binary: '/definitely/not/here/opencode' }),
      /找不到|ENOENT|not found|意外退出/i,
    );
    // The squatter was never adopted.
    assert.notEqual(getServerUrl(), `http://localhost:${port}`);
  } finally {
    await stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
