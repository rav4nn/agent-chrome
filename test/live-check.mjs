#!/usr/bin/env node
// Live check against a running proxy whose agent window is closed. It drives a real Chrome,
// so it is not part of npm test.
//   node test/live-check.mjs <port>
// 1. A client connect launches no Chrome.  2. A new tab launches it, behind the front app.
// 3. After the user quits Chrome, a client reconnect launches no Chrome.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const port = process.argv[2];
if (!/^\d+$/.test(port ?? '')) {
    console.error('Usage: node test/live-check.mjs <port>   (agent-chrome status lists the ports)');
    process.exit(2);
}

// Puppeteer comes from the global chrome-devtools-mcp install, so this repo needs no new dependency.
const puppeteerPath = path.join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    'chrome-devtools-mcp/build/src/third_party/index.js',
);
if (!fs.existsSync(puppeteerPath)) {
    console.error(`No global chrome-devtools-mcp at ${puppeteerPath}. Run: npm install -g chrome-devtools-mcp`);
    process.exit(2);
}
const { puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const browserURL = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await fetch(`${browserURL}/proxy/status`)).json();
const front = () => execFileSync('osascript', ['-e',
    'tell application "System Events" to return (name of first process whose frontmost is true)'],
{ encoding: 'utf8' }).trim();
const connect = () => puppeteer.connect({ browserURL, defaultViewport: null, handleDevToolsAsPage: true });

assert.equal((await status()).chromeRunning, false, 'close this Chrome before the check');
const app = front();

let browser = await connect();
assert.equal((await browser.pages()).length, 0);
await sleep(2000);
assert.equal((await status()).chromeRunning, false, 'connect launched Chrome');
console.log('ok 1: connect without launch');

await browser.newPage({ background: true });
assert.equal((await status()).chromeRunning, true, 'new tab did not launch Chrome');
assert.equal(front(), app, 'launch took focus');
console.log(`ok 2: new tab launched Chrome, front app still ${app}`);

// The user quits Chrome while the first client stays connected.
const gone = new Promise((r) => browser.once('disconnected', r));
const user = await connect();
await user.close();
await gone;
browser = await connect();
assert.equal((await browser.pages()).length, 0);
await sleep(3000);
assert.equal((await status()).chromeRunning, false, 'reconnect relaunched Chrome');
await browser.disconnect();
console.log('ok 3: reconnect after quit without launch');
