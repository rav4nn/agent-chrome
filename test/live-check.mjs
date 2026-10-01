#!/usr/bin/env node
// Live check against a running proxy whose agent window is closed. It drives a real Chrome,
// so it is not part of npm test.
//   node test/live-check.mjs <port>
// 1. A client connect launches no Chrome.  2. A new tab launches it, behind the front app.
// 3. A Dock Quit exits Chrome, and a client reconnect afterwards launches no Chrome.
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
// Compare pids, not app names: the user's own Chrome has the same name, and the user may
// switch apps during the check.
const frontPid = () => Number(execFileSync('osascript', ['-e',
    'tell application "System Events" to return unix id of (first process whose frontmost is true)'],
{ encoding: 'utf8' }).trim());
const connect = () => puppeteer.connect({ browserURL, defaultViewport: null, handleDevToolsAsPage: true });

assert.equal((await status()).chromeRunning, false, 'close this Chrome before the check');

let browser = await connect();
assert.equal((await browser.pages()).length, 0);
await sleep(2000);
assert.equal((await status()).chromeRunning, false, 'connect launched Chrome');
console.log('ok 1: connect without launch');

await browser.newPage({ background: true });
const { chromeRunning, chromePid } = await status();
assert.equal(chromeRunning, true, 'new tab did not launch Chrome');
for (let i = 0; i < 5; i++, await sleep(300)) assert.notEqual(frontPid(), chromePid, 'launch took focus');
console.log('ok 2: new tab launched Chrome, and it never became the front app');

// The user quits Chrome from the Dock (the same quit request, sent to this pid only) while
// the first client stays connected. Chrome must exit, not linger with no windows.
const gone = new Promise((r) => browser.once('disconnected', r));
execFileSync('osascript', ['-l', 'JavaScript', '-e',
    `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${chromePid}).terminate`]);
await Promise.race([gone, sleep(10000).then(() => assert.fail('Quit left Chrome running'))]);
browser = await connect();
assert.equal((await browser.pages()).length, 0);
await sleep(3000);
assert.equal((await status()).chromeRunning, false, 'reconnect relaunched Chrome');
await browser.disconnect();
console.log('ok 3: Quit exited Chrome, reconnect without launch');
