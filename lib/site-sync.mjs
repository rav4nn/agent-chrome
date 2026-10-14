// agent-chrome sync: copy one site's sign-in state from the real Chrome profile into the
// agent copy. Reads the real profile from snapshots only and never writes to it.
// Never prints a cookie value, the Keychain password or the derived key.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Chrome stores times as microseconds since 1601-01-01 UTC.
const EPOCH_DELTA_S = 11644473600n;
export const chromeTimeToUnix = (us) => Number(BigInt(us) - EPOCH_DELTA_S * 1000000n) / 1e6;
export const unixToChromeTime = (s) => BigInt(Math.round(s * 1e6)) + EPOCH_DELTA_S * 1000000n;

// "https://ElevenLabs.io/app" or "elevenlabs.io" → "elevenlabs.io".
export function normalizeSite(input) {
    let host = String(input ?? '').trim().toLowerCase();
    if (host.includes('://')) {
        try { host = new URL(host).hostname; } catch { host = ''; }
    }
    host = host.replace(/^\.+|\.+$/g, '');
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(host)) {
        throw new Error(`"${input}" is not a domain. Pass --site like elevenlabs.io.`);
    }
    return host;
}

// The site itself and its subdomains. A cookie's host_key may start with "." (domain cookie).
// Parent-domain cookies (".example.com" for --site app.example.com) are not included.
export function domainMatches(host, site) {
    const h = String(host).toLowerCase().replace(/^\./, '');
    return h === site || h.endsWith(`.${site}`);
}

// ─── Cookie crypto (macOS Chrome, "v10") ───

export const deriveKey = (password) => crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

// Plain value of one cookies row. DB version 24+ prefixes the plaintext with SHA-256(host_key).
export function decryptValue(encrypted, key, hostKey, dbVersion) {
    const buf = Buffer.from(encrypted ?? []);
    if (!buf.length) return '';
    if (buf.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('unknown cookie encryption (no v10 prefix)');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
    let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    if (dbVersion >= 24) {
        const hash = crypto.createHash('sha256').update(hostKey).digest();
        if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) throw new Error('cookie host hash does not match');
        plain = plain.subarray(32);
    }
    return plain.toString('utf8');
}

// ─── Cookies row → CDP Network.CookieParam ───

const SAMESITE = { 0: 'None', 1: 'Lax', 2: 'Strict' };
const PRIORITY = { 0: 'Low', 1: 'Medium', 2: 'High' };
const SOURCE_SCHEME = { 0: 'Unset', 1: 'NonSecure', 2: 'Secure' };

// A host-only cookie (host_key without a leading dot) must be set by url, or CDP makes it a
// domain cookie. A cookie with expires_utc 0 or has_expires 0 stays a session cookie.
export function cdpCookieFromRow(row, value) {
    const host = row.host_key;
    const secure = Boolean(Number(row.is_secure));
    const c = { name: row.name, value, path: row.path, secure, httpOnly: Boolean(Number(row.is_httponly)) };
    if (host.startsWith('.')) c.domain = host;
    else c.url = `${secure || Number(row.source_scheme) === 2 ? 'https' : 'http'}://${host}/`;
    const expires = BigInt(row.expires_utc);
    if (Number(row.has_expires) && expires > 0n) c.expires = chromeTimeToUnix(expires);
    const sameSite = SAMESITE[Number(row.samesite)];
    if (sameSite) c.sameSite = sameSite;
    const priority = PRIORITY[Number(row.priority)];
    if (priority) c.priority = priority;
    const scheme = SOURCE_SCHEME[Number(row.source_scheme)];
    if (scheme) c.sourceScheme = scheme;
    if (Number(row.source_port) > 0) c.sourcePort = Number(row.source_port);
    if (row.top_frame_site_key) {
        c.partitionKey = { topLevelSite: row.top_frame_site_key, hasCrossSiteAncestor: Boolean(Number(row.has_cross_site_ancestor)) };
    }
    return c;
}

// A CDP cookie as returned by Storage.getCookies → the param that deletes it (expiry in the past).
export function cdpDeleteParam(c) {
    const p = { name: c.name, value: '', path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: 1 };
    if (c.domain.startsWith('.')) p.domain = c.domain;
    else p.url = `https://${c.domain}/`;
    if (c.partitionKey) p.partitionKey = c.partitionKey;
    return p;
}

const isExpired = (row, nowUs) => Number(row.has_expires) && BigInt(row.expires_utc) > 0n && BigInt(row.expires_utc) <= nowUs;

// ─── Cookies DB ───

async function sqlite() {
    try {
        return await import('node:sqlite');
    } catch {
        throw new Error(`sync needs Node 22.5 or later (node:sqlite). This is Node ${process.version}.`);
    }
}

// Copy a live SQLite DB (plus its journal or WAL) into tmpDir and open the copy. Opening it
// rolls back a half-done transaction from the journal. A torn copy fails quick_check: retry.
export async function snapshotDb(file, tmpDir) {
    const { DatabaseSync } = await sqlite();
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist.`);
    for (let attempt = 1; ; attempt++) {
        const dir = fs.mkdtempSync(path.join(tmpDir, 'db-'));
        const dst = path.join(dir, path.basename(file));
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, dst + suffix);
        }
        try {
            const db = new DatabaseSync(dst);
            if (db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok') return db;
            db.close();
        } catch { /* torn copy */ }
        if (attempt === 3) throw new Error(`Could not read a consistent snapshot of ${file}. Try again.`);
        await new Promise((r) => setTimeout(r, 300));
    }
}

export function dbVersion(db) {
    return Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
}

const columnsOf = (db) => db.prepare('PRAGMA table_info(cookies)').all().map((c) => c.name);

// Rows of the cookies table whose host_key matches the site. Integers stay BigInt: Chrome
// times in µs are above 2^53.
export function siteRows(db, site) {
    const stmt = db.prepare('SELECT * FROM cookies');
    stmt.setReadBigInts(true);
    return stmt.all().filter((r) => domainMatches(r.host_key, site));
}

// File-level merge into the agent copy's Cookies DB (agent window closed): delete the copy's
// rows for the sites, insert the real rows. One transaction. Returns { removed, inserted }.
export async function mergeCookieRows(copyDbFile, srcDb, sites) {
    const { DatabaseSync } = await sqlite();
    const dst = new DatabaseSync(copyDbFile);
    try {
        const vs = dbVersion(srcDb);
        const vd = dbVersion(dst);
        if (vs !== vd) {
            throw new Error(`Cookie DB versions differ (real profile ${vs}, agent copy ${vd}). `
                + 'Update Chrome, open the agent window once so it upgrades its copy, then try again.');
        }
        const cols = columnsOf(srcDb);
        if (cols.join() !== columnsOf(dst).join()) throw new Error('Cookie DB columns differ between the real profile and the agent copy.');
        const rows = sites.flatMap((s) => siteRows(srcDb, s));
        const hosts = [...new Set(dst.prepare('SELECT DISTINCT host_key FROM cookies').all().map((r) => r.host_key))]
            .filter((h) => sites.some((s) => domainMatches(h, s)));
        const del = dst.prepare('DELETE FROM cookies WHERE host_key = ?');
        const ins = dst.prepare(`INSERT OR REPLACE INTO cookies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        let removed = 0;
        dst.exec('BEGIN IMMEDIATE');
        try {
            for (const h of hosts) removed += Number(del.run(h).changes);
            for (const r of rows) ins.run(...cols.map((c) => r[c]));
            dst.exec('COMMIT');
        } catch (e) {
            dst.exec('ROLLBACK');
            throw e;
        }
        return { removed, inserted: rows.length };
    } finally {
        dst.close();
    }
}

// ─── IndexedDB and Local Storage ───

// Per-origin IndexedDB folders: "https_<host>_<port>.indexeddb.leveldb" and ".indexeddb.blob".
export function idbFolders(names, site) {
    return names.filter((n) => {
        const m = /^(?:https?)_(.+)_\d+\.indexeddb\.(?:leveldb|blob)$/.exec(n);
        return m && domainMatches(m[1], site);
    }).sort();
}

const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// Origins with data in the shared Local Storage leveldb. Reads key prefixes only: values
// stay in the files. Compressed .ldb blocks can hide a prefix, so callers also try the site.
export function localStorageOrigins(dir) {
    const origins = new Set();
    for (const f of listDir(dir).filter((n) => /\.(ldb|log)$/.test(n))) {
        let text;
        try { text = fs.readFileSync(path.join(dir, f)).toString('latin1'); } catch { continue; }
        for (const m of text.matchAll(/(?:_|META:)(https?:\/\/[a-z0-9.-]+(?::\d+)?)/g)) origins.add(m[1]);
    }
    return origins;
}
const originHost = (origin) => new URL(origin).hostname;

// Copy one origin folder from the real profile into the copy: stage, then swap in, with the old
// folder kept until the new one is in place. The real Chrome may compact the folder during the
// copy (a file goes away): try again.
function copyFolder(src, dst) {
    const stage = `${dst}.agent-chrome-sync`;
    for (let attempt = 1; ; attempt++) {
        fs.rmSync(stage, { recursive: true, force: true });
        try {
            fs.cpSync(src, stage, { recursive: true });
            break;
        } catch (e) {
            if (attempt === 3 || e.code !== 'ENOENT') { fs.rmSync(stage, { recursive: true, force: true }); throw e; }
        }
    }
    const old = `${dst}.agent-chrome-old`;
    fs.rmSync(old, { recursive: true, force: true });
    const hadOld = fs.existsSync(dst);
    if (hadOld) fs.renameSync(dst, old);
    try {
        fs.renameSync(stage, dst);
    } catch (e) {
        if (hadOld) fs.renameSync(old, dst);
        fs.rmSync(stage, { recursive: true, force: true });
        throw e;
    }
    fs.rmSync(old, { recursive: true, force: true });
}

// ─── CDP ───

// A CDP client on any transport. call(method, params, sessionId); on(method, fn) for events.
function cdpClient(send, timeoutMs) {
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    const handle = (m) => {
        if (m.method) { for (const fn of listeners.get(m.method) ?? []) fn(m.params, m.sessionId); return; }
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
        else p.resolve(m.result);
    };
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const i = ++id;
        const timer = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, timeoutMs);
        pending.set(i, {
            method,
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
    });
    const on = (method, fn) => {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(fn);
        return () => listeners.get(method).delete(fn);
    };
    return { handle, call, on };
}

// The agent Chrome, through its proxy.
export async function cdpConnect(port, timeoutMs = 10000) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/proxy`);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error(`Could not connect to the agent-chrome proxy on port ${port}.`));
    });
    const c = cdpClient((s) => ws.send(s), timeoutMs);
    ws.onmessage = (e) => c.handle(JSON.parse(e.data));
    return { call: c.call, on: c.on, close: () => ws.close() };
}

export const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A headless Chrome on its own temp user data dir, driven over --remote-debugging-pipe (no
// port). The mock keychain keeps it away from the real Keychain.
async function launchHeadless(userDataDir, chromePath = CHROME_BIN, timeoutMs = 15000) {
    const proc = spawn(chromePath, [
        '--headless=new', `--user-data-dir=${userDataDir}`, '--remote-debugging-pipe', '--use-mock-keychain',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
        '--disable-background-networking', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.on('error', () => {});
    const c = cdpClient((s) => proc.stdio[3].write(`${s}\0`), timeoutMs);
    let buf = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (let i; (i = buf.indexOf(0)) >= 0; buf = buf.subarray(i + 1)) c.handle(JSON.parse(buf.subarray(0, i).toString()));
    });
    proc.stdio[3].on('error', () => {});
    const close = async () => {
        try { await c.call('Browser.close'); } catch { /* exits before it answers */ }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (proc.exitCode === null) proc.kill('SIGKILL');
    };
    try {
        await c.call('Browser.getVersion');
    } catch (e) {
        proc.kill('SIGKILL');
        throw new Error(`Could not start a headless Chrome to read Local Storage: ${e.message}`);
    }
    return { call: c.call, on: c.on, close };
}

// A tab on the origin that runs none of the site's code: the navigation never reaches the
// network or a service worker; the tab gets an empty page. Returns { sessionId, close }.
async function openOriginTab(cdp, origin) {
    const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank', background: true });
    const close = () => cdp.call('Target.closeTarget', { targetId }).catch(() => {});
    try {
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
        const off = cdp.on('Fetch.requestPaused', (p, sid) => {
            if (sid !== sessionId) return;
            cdp.call('Fetch.fulfillRequest', {
                requestId: p.requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: '',
            }, sessionId).catch(() => {});
        });
        try {
            await cdp.call('Network.setBypassServiceWorker', { bypass: true }, sessionId);
            await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
            await cdp.call('Page.navigate', { url: `${origin}/agent-chrome-sync` }, sessionId);
            for (let i = 0; ; i++) {
                const { result } = await cdp.call('Runtime.evaluate',
                    { expression: 'document.readyState === "complete" && location.origin', returnByValue: true }, sessionId);
                if (result.value === origin) break;
                if (i === 50) throw new Error(`could not open a tab on ${origin}`);
                await new Promise((r) => setTimeout(r, 100));
            }
        } catch (e) {
            off();
            throw e;
        }
        return { sessionId, close: async () => { off(); await close(); } };
    } catch (e) {
        await close();
        throw e;
    }
}

// Local Storage items of the origins, read from a snapshot of the real profile's Local Storage
// in a headless Chrome. Returns Map(origin → [[key, value], …]); origins with no items are left out.
export async function readLocalStorage(realDir, origins, tmpDir, chromePath) {
    const src = path.join(realDir, 'Local Storage', 'leveldb');
    const items = new Map();
    if (!origins.length || !fs.existsSync(src)) return items;
    const userDataDir = fs.mkdtempSync(path.join(tmpDir, 'ls-'));
    const dst = path.join(userDataDir, 'Default', 'Local Storage', 'leveldb');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (f) => path.basename(f) !== 'LOCK' });
    const chrome = await launchHeadless(userDataDir, chromePath);
    try {
        for (const origin of origins) {
            const tab = await openOriginTab(chrome, origin);
            try {
                const { result } = await chrome.call('Runtime.evaluate',
                    { expression: 'JSON.stringify(Object.entries(localStorage))', returnByValue: true }, tab.sessionId);
                const entries = JSON.parse(result.value);
                if (entries.length) items.set(origin, entries);
            } finally {
                await tab.close();
            }
        }
    } finally {
        await chrome.close();
    }
    return items;
}

// Replace the origin's Local Storage in the agent Chrome with the entries. Opens (and closes)
// one background tab through the proxy, so it launches the agent Chrome if it is closed.
async function writeLocalStorage(cdp, origin, entries) {
    const tab = await openOriginTab(cdp, origin);
    try {
        // One script: if a write fails (quota), the origin gets its old items back.
        const expression = `(() => {
            const old = Object.entries(localStorage);
            const fill = (items) => { localStorage.clear(); for (const [k, v] of items) localStorage.setItem(k, v); };
            try { fill(${JSON.stringify(entries)}); } catch (e) { fill(old); throw e; }
            return localStorage.length;
        })()`;
        const { result, exceptionDetails } = await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, tab.sessionId);
        if (exceptionDetails) throw new Error(`could not write Local Storage for ${origin}; its old items are back`);
        return result.value;
    } finally {
        await tab.close();
    }
}

function keychainKey() {
    let password;
    try {
        password = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
    } catch {
        throw new Error('Could not read "Chrome Safe Storage" from the Keychain (denied or missing).');
    }
    return deriveKey(password);
}

// Replace the site's cookies in the running agent Chrome. Every real cookie is decrypted
// before the old ones go: one unreadable cookie stops the sync with the old cookies in place.
// Returns { removed, set, skipped, failed }.
async function liveCookies(cdp, rows, sites, version, key) {
    const nowUs = unixToChromeTime(Date.now() / 1000);
    const params = [];
    let skipped = 0;
    for (const r of rows) {
        if (isExpired(r, nowUs)) { skipped++; continue; }
        let value;
        try {
            value = r.value || decryptValue(r.encrypted_value, key, r.host_key, version);
        } catch (e) {
            throw new Error(`Could not decrypt the cookie ${r.name} of ${r.host_key} (${e.message}). The cookies of that site did not change.`);
        }
        params.push(cdpCookieFromRow(r, value));
    }
    const { cookies } = await cdp.call('Storage.getCookies');
    const old = cookies.filter((c) => sites.some((s) => domainMatches(c.domain, s)));
    if (old.length) await cdp.call('Storage.setCookies', { cookies: old.map(cdpDeleteParam) });
    const failed = [];
    try {
        if (params.length) await cdp.call('Storage.setCookies', { cookies: params });
    } catch {
        // One bad cookie fails the batch: set them one by one, and name (never show) the failures.
        for (const p of params) {
            try { await cdp.call('Storage.setCookies', { cookies: [p] }); } catch { failed.push(p.name); }
        }
    }
    return { removed: old.length, set: params.length - failed.length, skipped, failed };
}

// ─── Window state ───

async function proxyStatus(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/proxy/status`, { signal: AbortSignal.timeout(1000) });
        return await res.json();
    } catch {
        return null;
    }
}

// Chrome's SingletonLock symlink points at "<host>-<pid>" while a Chrome runs on the folder.
export function lockHolderAlive(userDataDir) {
    let target;
    try { target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock')); } catch { return false; }
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function windowOpen(port, userDataDir) {
    const st = await proxyStatus(port);
    if (st?.chromeRunning) return true;
    if (lockHolderAlive(userDataDir)) {
        throw new Error(`A Chrome runs on ${userDataDir}, but its proxy on port ${port} does not answer. `
            + 'Quit that Chrome window, or run agent-chrome status.');
    }
    return false;
}

async function closeAgentChrome(port, userDataDir) {
    const cdp = await cdpConnect(port);
    try { await cdp.call('Browser.close'); } catch { /* Chrome may exit before it answers */ }
    cdp.close();
    for (let i = 0; i < 60; i++) {
        if (!(await proxyStatus(port))?.chromeRunning && !lockHolderAlive(userDataDir)) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('The agent window did not close within 15 seconds. Nothing in the copy changed.');
}

// ─── The command ───

// realDir/copyDir: the profile folders ("…/Chrome/Default", "…/profiles/<slug>/Default").
// userDataDir: the copy's user data dir (holds SingletonLock). port: the slug's proxy.
export async function syncSites({ realDir, copyDir, userDataDir, port, sites, restart = false, dryRun = false, log = console.log, chromePath }) {
    if (!fs.existsSync(realDir)) throw new Error(`The real profile folder ${realDir} is missing.`);
    if (!fs.existsSync(copyDir)) throw new Error(`The agent copy ${copyDir} is missing. Run agent-chrome add again.`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-sync-'));
    let real;
    try {
        // Plan from snapshots; change nothing yet.
        real = await snapshotDb(path.join(realDir, 'Cookies'), tmp);
        const version = dbVersion(real);
        const copySnap = await snapshotDb(path.join(copyDir, 'Cookies'), tmp);
        const copyVersion = dbVersion(copySnap);
        copySnap.close();
        if (version !== copyVersion) {
            throw new Error(`Cookie DB versions differ (real profile ${version}, agent copy ${copyVersion}). `
                + 'Update Chrome, open the agent window once so it upgrades its copy, then try again.');
        }
        const realIdb = listDir(path.join(realDir, 'IndexedDB'));
        const lsOrigins = [...localStorageOrigins(path.join(realDir, 'Local Storage', 'leveldb'))];
        const plan = sites.map((site) => ({
            site,
            rows: siteRows(real, site),
            idb: idbFolders(realIdb, site),
            ls: lsOrigins.filter((o) => domainMatches(originHost(o), site)).sort(),
        }));
        const empty = plan.filter((p) => !p.rows.length && !p.idb.length && !p.ls.length);
        if (empty.length) {
            throw new Error(empty.map((p) => `${p.site} matched nothing in ${realDir} (no cookies, IndexedDB or Local Storage).`).join('\n')
                + ' Check the domain, and that you are signed in to it in your real Chrome.');
        }

        // Local Storage: read the real items now, before anything changes. The site's own origin
        // is always tried, because a compressed file can hide its key prefix from the listing.
        const lsItems = new Map(plan.map((p) => [p.site, new Map()]));
        let lsError = null;
        if (!dryRun) {
            for (const p of plan) if (!p.ls.includes(`https://${p.site}`)) p.ls.push(`https://${p.site}`);
            try {
                const items = await readLocalStorage(realDir, [...new Set(plan.flatMap((p) => p.ls))], tmp, chromePath);
                for (const p of plan) for (const o of p.ls) if (items.has(o)) lsItems.get(p.site).set(o, items.get(o));
            } catch (e) {
                lsError = e.message;
            }
        }

        // open: the agent window will be open while cookies and IndexedDB are copied.
        let open = await windowOpen(port, userDataDir);
        const needIdb = plan.some((p) => p.idb.length);
        log(`Agent window: ${open ? 'open' : 'closed'}.`);
        if (open && needIdb && restart) {
            log(`${dryRun ? 'Would close' : 'Closing'} the agent window (--restart). Tabs that other sessions opened there close too.`);
            if (!dryRun) await closeAgentChrome(port, userDataDir);
            open = false;
        }

        const results = new Map(plan.map((p) => [p.site, {}]));
        let failed = Boolean(lsError);
        if (dryRun) {
            for (const p of plan) results.get(p.site).cookies = `would copy ${p.rows.length} (${open ? 'live' : 'file'})`;
        } else if (open) {
            log('Reading the Chrome Safe Storage key from the Keychain to set cookies live (macOS may ask once).');
            const key = keychainKey();
            const cdp = await cdpConnect(port);
            try {
                for (const p of plan) {
                    const r = await liveCookies(cdp, p.rows, [p.site], version, key);
                    results.get(p.site).cookies = `${r.set} copied (live, ${r.removed} old removed`
                        + `${r.skipped ? `, ${r.skipped} expired skipped` : ''})`
                        + `${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}`;
                    if (r.failed.length) failed = true;
                }
            } finally {
                cdp.close();
            }
        } else {
            if (await windowOpen(port, userDataDir)) throw new Error('The agent window opened during sync. Run sync again.');
            const r = await mergeCookieRows(path.join(copyDir, 'Cookies'), real, sites);
            for (const p of plan) results.get(p.site).cookies = `${p.rows.length} copied (file)`;
            log(`Cookies: ${r.inserted} copied into the agent copy, ${r.removed} old rows removed.`);
        }

        for (const p of plan) {
            const res = results.get(p.site);
            if (!p.idb.length) res.idb = 'none in real profile';
            else if (dryRun) res.idb = open ? `${p.idb.length} would wait: window open, needs --restart` : `would copy ${p.idb.length} (file)`;
            else if (open) res.idb = `${p.idb.length} skipped: window open, needs --restart`;
            else {
                for (const name of p.idb) copyFolder(path.join(realDir, 'IndexedDB', name), path.join(copyDir, 'IndexedDB', name));
                res.idb = `${p.idb.length} copied (file)`;
            }
        }

        // Local Storage goes in live, one origin at a time, through a tab with none of the site's
        // code. With the window closed, that tab opens the agent Chrome; it closes again after.
        const lsCount = (p) => [...lsItems.get(p.site).values()].reduce((n, e) => n + e.length, 0);
        const proxyUp = !dryRun && !lsError && plan.some((p) => lsItems.get(p.site).size) && (await proxyStatus(port)) !== null;
        let cdp = null;
        for (const p of plan) {
            const res = results.get(p.site);
            const found = lsItems.get(p.site);
            if (dryRun) res.ls = p.ls.length ? `would copy ${p.ls.length} origin${p.ls.length > 1 ? 's' : ''} (live)` : 'none found';
            else if (lsError) res.ls = 'not copied: could not read it (see below)';
            else if (!found.size) res.ls = 'none in real profile';
            else if (!proxyUp) {
                res.ls = `${found.size} origin${found.size > 1 ? 's' : ''} not copied: proxy on port ${port} is down`;
                failed = true;
            }
            else {
                try {
                    cdp ??= await cdpConnect(port, 30000);
                    for (const [origin, entries] of found) await writeLocalStorage(cdp, origin, entries);
                    res.ls = `${found.size} origin${found.size > 1 ? 's' : ''}, ${lsCount(p)} keys copied (live)`;
                } catch (e) {
                    res.ls = `not copied: ${e.message}`;
                    failed = true;
                }
            }
        }
        cdp?.close();

        const rows = [['SITE', 'COOKIES', 'INDEXEDDB ORIGINS', 'LOCAL STORAGE'],
            ...plan.map((p) => { const r = results.get(p.site); return [p.site, r.cookies, r.idb, r.ls]; })];
        const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
        for (const r of rows) log(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());

        if (lsError) log(`\nLocal Storage: ${lsError}`);
        const idbWaiting = open && needIdb;
        if (idbWaiting) {
            log('\nIndexedDB is not copied while the agent window is open. Reload the site first. If it still shows '
                + 'you signed out, rerun with --restart: it closes the agent window, copies, and the next new_page reopens it. '
                + 'A restart closes every tab in the agent window, including tabs other sessions opened.');
        }
        if (dryRun) log('\nDry run: nothing changed.');
        else if (failed) log('\nSync did not finish: see the table. The other parts are copied.');
        else log(open ? '\nReload the site\'s tab to use the new sign-in.' : '\nDone. The next new_page opens the agent window with the synced sign-in.');
        return { plan, results, open, idbWaiting, failed };
    } finally {
        real?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
