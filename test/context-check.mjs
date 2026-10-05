#!/usr/bin/env node
// Live check: a tab opens in a new browser context (isolatedContext) while another context
// already has a tab, in both orders. Each context gets one window, and a second tab in a
// context reuses it. It starts its own proxy on a throwaway profile, so it
// drives a real Chrome and is not part of npm test.
//   node test/context-check.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Puppeteer comes from the global chrome-devtools-mcp install, as in live-check.mjs.
const puppeteerPath = path.join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    'chrome-devtools-mcp/build/src/third_party/index.js',
);
const { puppeteer } = await import(pathToFileURL(puppeteerPath).href);
const proxyFile = fileURLToPath(new URL('../pipe-cdp-proxy.mjs', import.meta.url));
const port = 9499;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(isolatedFirst) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-ctx-'));
    const proxy = spawn('node', [proxyFile, '--port', String(port), '--user-data-dir', userDataDir], { stdio: 'ignore' });
    try {
        for (let i = 0; i < 40; i++) {
            try { await fetch(`http://127.0.0.1:${port}/proxy/status`); break; } catch { await sleep(250); }
        }
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
        const windowOf = async (page) =>
            (await (await page.createCDPSession()).send('Browser.getWindowForTarget')).windowId;
        const isolated = async () => {
            const context = await browser.createBrowserContext();
            const first = await context.newPage();
            const second = await context.newPage();
            assert.equal(await windowOf(second), await windowOf(first), 'second tab reuses its context window');
            return windowOf(first);
        };
        const normal = async () => windowOf(await browser.newPage());
        let isolatedWindow, normalWindow;
        if (isolatedFirst) { isolatedWindow = await isolated(); normalWindow = await normal(); }
        else { normalWindow = await normal(); isolatedWindow = await isolated(); }
        assert.notEqual(isolatedWindow, normalWindow, 'each context gets its own window');
        await browser.close().catch(() => {}); // Chrome exits before it answers
        console.log(`ok: ${isolatedFirst ? 'isolated context first' : 'default context first'}`);
    } finally {
        proxy.kill();
        await sleep(500);
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
}

await assert.doesNotReject(run(false));
await assert.doesNotReject(run(true));
