// The proxy answers local tools only: no web page (Origin header), no other Host name.
// Starts a throwaway proxy with a fake Chrome (/usr/bin/false), so no real Chrome opens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const proxyPath = fileURLToPath(new URL('../pipe-cdp-proxy.mjs', import.meta.url));
let proxy, port, dataDir;

const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
    port = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-guard-'));
    proxy = spawn(process.execPath, [proxyPath, '--port', String(port), '--user-data-dir', dataDir, '--chrome-path', '/usr/bin/false'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
        proxy.stdout.on('data', (d) => { if (String(d).includes('Listening')) resolve(); });
        proxy.on('error', reject);
        proxy.on('exit', (code) => reject(new Error(`proxy exited before listening (code ${code})`)));
    });
}, { timeout: 10000 });

after(() => {
    proxy.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/version', headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

// Resolves with 'open' for an accepted connection, or with the HTTP status of a refused upgrade.
const wsCall = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/proxy`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('error', reject);
});

test('HTTP: local tool allowed, web page and foreign Host refused', async () => {
    assert.equal(await get({}), 200);
    assert.equal(await get({ Host: `localhost:${port}` }), 200);
    assert.equal(await get({ Host: `LOCALHOST:${port}` }), 200);
    assert.equal(await get({ Host: `localhost:${port}@rebind.example.com` }), 403);
    assert.equal(await get({ Origin: 'https://example.com' }), 403);
    assert.equal(await get({ Host: `rebind.example.com:${port}` }), 403);
});

test('WebSocket: local tool allowed, web page and foreign Host refused', async () => {
    assert.equal(await wsCall({}), 'open');
    assert.equal(await wsCall({ Origin: 'https://example.com' }), 401);
    assert.equal(await wsCall({ Origin: 'null' }), 401);
    assert.equal(await wsCall({ Host: `rebind.example.com:${port}` }), 401);
});
