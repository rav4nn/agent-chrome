// agent-chrome sync: pure helpers, cookie crypto, and the file-level merge on temp DBs.
// No real Chrome, no Keychain.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../bin/agent-chrome.mjs';
import {
    cdpCookieFromRow, chromeTimeToUnix, decryptValue, deriveKey, domainMatches, idbFolders,
    localStorageOrigins, mergeCookieRows, normalizeSite, snapshotDb, syncSites, unixToChromeTime,
} from '../lib/site-sync.mjs';

// The cookies schema of Chrome's Cookies DB, meta version 24.
const SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);`;

const TEST_KEY = deriveKey('test-password');
function encrypt(value, host, withHash) {
    const prefix = withHash ? crypto.createHash('sha256').update(host).digest() : Buffer.alloc(0);
    const c = crypto.createCipheriv('aes-128-cbc', TEST_KEY, Buffer.alloc(16, ' '));
    return Buffer.concat([Buffer.from('v10'), c.update(Buffer.concat([prefix, Buffer.from(value)])), c.final()]);
}

const EXPIRES = unixToChromeTime(Date.UTC(2030, 0, 1) / 1000);
function makeDb(file, version, cookies) {
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta VALUES ('version', ?), ('last_compatible_version', ?)").run(String(version), String(version));
    const ins = db.prepare(`INSERT INTO cookies VALUES (1, ?, '', ?, '', ?, '/', ?, 1, 1, 1, 1, 1, 1, 1, 2, 443, 1, 0, 0)`);
    for (const [host, name] of cookies) ins.run(host, name, encrypt(`${name}-value`, host, true), EXPIRES);
    db.close();
}
const names = (file) => {
    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT host_key, name FROM cookies ORDER BY host_key, name').all().map((r) => `${r.host_key}|${r.name}`);
    db.close();
    return rows;
};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-sync-test-'));

test('domain matching covers the site and its subdomains only', () => {
    for (const h of ['elevenlabs.io', '.elevenlabs.io', 'api.elevenlabs.io', '.api.elevenlabs.io', 'ElevenLabs.IO']) {
        assert.equal(domainMatches(h, 'elevenlabs.io'), true, h);
    }
    for (const h of ['notelevenlabs.io', 'elevenlabs.io.evil.com', '.io', 'elevenlabs.com']) {
        assert.equal(domainMatches(h, 'elevenlabs.io'), false, h);
    }
    assert.equal(domainMatches('.example.com', 'app.example.com'), false, 'no parent-domain cookies');
});

test('normalizes --site values', () => {
    assert.equal(normalizeSite('ElevenLabs.io'), 'elevenlabs.io');
    assert.equal(normalizeSite('https://elevenlabs.io/app/settings'), 'elevenlabs.io');
    assert.equal(normalizeSite('.elevenlabs.io'), 'elevenlabs.io');
    for (const bad of ['', 'localhost', 'a b.com', 'elevenlabs.io/app', '*.x.com']) assert.throws(() => normalizeSite(bad), bad);
});

test('decrypts v10 cookies with and without the host hash', () => {
    assert.equal(decryptValue(encrypt('s3cret=1', 'api.x.com', true), TEST_KEY, 'api.x.com', 24), 's3cret=1');
    assert.equal(decryptValue(encrypt('s3cret=1', 'api.x.com', false), TEST_KEY, 'api.x.com', 23), 's3cret=1');
    assert.equal(decryptValue(Buffer.alloc(0), TEST_KEY, 'x.com', 24), '');
    assert.throws(() => decryptValue(encrypt('v', 'a.com', true), TEST_KEY, 'b.com', 24), /hash/);
    assert.throws(() => decryptValue(Buffer.from('v11abc'), TEST_KEY, 'a.com', 24), /v10/);
    assert.throws(() => decryptValue(encrypt('v', 'a.com', true), deriveKey('wrong'), 'a.com', 24));
});

test('converts Chrome epoch times and keeps session cookies', () => {
    assert.equal(chromeTimeToUnix(11644473600000000n), 0);
    assert.equal(chromeTimeToUnix(unixToChromeTime(1767225600.5)), 1767225600.5);
    assert.equal(unixToChromeTime(0), 11644473600000000n);
    const base = { host_key: '.x.com', name: 'n', path: '/', is_secure: 1n, is_httponly: 0n, samesite: 2n,
        priority: 1n, source_scheme: 2n, source_port: 443n, top_frame_site_key: '', has_cross_site_ancestor: 0n };
    const persistent = cdpCookieFromRow({ ...base, has_expires: 1n, expires_utc: unixToChromeTime(1893456000) }, 'v');
    assert.equal(persistent.expires, 1893456000);
    assert.equal(persistent.domain, '.x.com');
    assert.equal(persistent.sameSite, 'Strict');
    for (const session of [{ has_expires: 0n, expires_utc: 0n }, { has_expires: 1n, expires_utc: 0n }]) {
        assert.equal('expires' in cdpCookieFromRow({ ...base, ...session }, 'v'), false);
    }
    const hostOnly = cdpCookieFromRow({ ...base, host_key: 'x.com', samesite: -1n, has_expires: 0n, expires_utc: 0n,
        top_frame_site_key: 'https://top.com', has_cross_site_ancestor: 1n }, 'v');
    assert.equal(hostOnly.url, 'https://x.com/');
    assert.equal('domain' in hostOnly, false);
    assert.equal('sameSite' in hostOnly, false);
    assert.deepEqual(hostOnly.partitionKey, { topLevelSite: 'https://top.com', hasCrossSiteAncestor: true });
});

test('file merge replaces the site rows and leaves the others', async () => {
    const dir = tmpDir();
    const real = path.join(dir, 'real.db');
    const copy = path.join(dir, 'Cookies');
    makeDb(real, 24, [['.elevenlabs.io', 'session'], ['api.elevenlabs.io', 'token'], ['other.com', 'real-only']]);
    makeDb(copy, 24, [['.elevenlabs.io', 'stale'], ['elevenlabs.io', 'old'], ['notelevenlabs.io', 'keep'], ['other.com', 'keep']]);
    const src = new DatabaseSync(real);
    assert.deepEqual(await mergeCookieRows(copy, src, ['elevenlabs.io']), { removed: 2, inserted: 2 });
    assert.deepEqual(names(copy), ['.elevenlabs.io|session', 'api.elevenlabs.io|token', 'notelevenlabs.io|keep', 'other.com|keep']);
    // encrypted_value and the µs times survive byte for byte.
    const db = new DatabaseSync(copy);
    const row = db.prepare("SELECT encrypted_value, expires_utc FROM cookies WHERE name = 'session'");
    row.setReadBigInts(true);
    const { encrypted_value: enc, expires_utc: exp } = row.get();
    assert.equal(exp, EXPIRES);
    assert.equal(decryptValue(enc, TEST_KEY, '.elevenlabs.io', 24), 'session-value');
    db.close();
    src.close();
    fs.rmSync(dir, { recursive: true });
});

test('file merge stops when the DB versions differ', async () => {
    const dir = tmpDir();
    makeDb(path.join(dir, 'real.db'), 24, [['.a.com', 'x']]);
    makeDb(path.join(dir, 'Cookies'), 23, [['.a.com', 'y']]);
    const src = new DatabaseSync(path.join(dir, 'real.db'));
    await assert.rejects(mergeCookieRows(path.join(dir, 'Cookies'), src, ['a.com']), /versions differ/);
    assert.deepEqual(names(path.join(dir, 'Cookies')), ['.a.com|y']);
    src.close();
    fs.rmSync(dir, { recursive: true });
});

test('snapshot reads a DB without touching the original', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'Cookies');
    makeDb(file, 24, [['.a.com', 'x']]);
    const before = fs.readFileSync(file);
    const db = await snapshotDb(file, dir);
    assert.notEqual(db.location(), file);
    db.close();
    assert.deepEqual(fs.readFileSync(file), before);
    fs.rmSync(dir, { recursive: true });
});

test('picks the IndexedDB folders of the site', () => {
    const listing = [
        'https_elevenlabs.io_0.indexeddb.leveldb',
        'https_elevenlabs.io_0.indexeddb.blob',
        'https_api.elevenlabs.io_0.indexeddb.leveldb',
        'http_elevenlabs.io_8080.indexeddb.leveldb',
        'https_notelevenlabs.io_0.indexeddb.leveldb',
        'https_elevenlabs.io.evil.com_0.indexeddb.leveldb',
        'chrome-extension_abc_0.indexeddb.leveldb',
        'elevenlabs.io',
    ];
    assert.deepEqual(idbFolders(listing, 'elevenlabs.io'), [
        'http_elevenlabs.io_8080.indexeddb.leveldb',
        'https_api.elevenlabs.io_0.indexeddb.leveldb',
        'https_elevenlabs.io_0.indexeddb.blob',
        'https_elevenlabs.io_0.indexeddb.leveldb',
    ]);
});

// Local Storage leveldb keys are "_<origin>\0\x01<key>"; "META:<origin>" holds per-origin metadata.
function fakeLocalStorage(dir, origins) {
    const ls = path.join(dir, 'Local Storage', 'leveldb');
    fs.mkdirSync(ls, { recursive: true });
    const body = origins.map((o, i) => (i % 2 ? `META:${o}` : `_${o}\x00\x01some-key`)).join('\x08junk\x00');
    fs.writeFileSync(path.join(ls, '000003.log'), Buffer.from(`\x01\x02${body}\x00`, 'latin1'));
    fs.writeFileSync(path.join(ls, 'CURRENT'), '_https://not-a-table.test');
    return ls;
}

test('lists Local Storage origins from key prefixes', () => {
    const dir = tmpDir();
    const ls = fakeLocalStorage(dir, ['https://site.test', 'https://api.site.test:8443', 'https://other.test', 'http://site.test']);
    assert.deepEqual([...localStorageOrigins(ls)].sort(),
        ['http://site.test', 'https://api.site.test:8443', 'https://other.test', 'https://site.test']);
    assert.deepEqual([...localStorageOrigins(path.join(dir, 'missing'))], []);
    fs.rmSync(dir, { recursive: true });
});

// A fake real profile and agent copy; port 1 has no proxy, so the window counts as closed.
function fakeProfiles() {
    const dir = tmpDir();
    const realDir = path.join(dir, 'real', 'Default');
    const userDataDir = path.join(dir, 'copy');
    const copyDir = path.join(userDataDir, 'Default');
    for (const d of [realDir, copyDir]) fs.mkdirSync(path.join(d, 'IndexedDB'), { recursive: true });
    makeDb(path.join(realDir, 'Cookies'), 24, [['.site.test', 'auth'], ['other.test', 'x']]);
    makeDb(path.join(copyDir, 'Cookies'), 24, [['.site.test', 'stale'], ['other.test', 'keep']]);
    const idb = path.join(realDir, 'IndexedDB', 'https_site.test_0.indexeddb.leveldb');
    fs.mkdirSync(idb);
    fs.writeFileSync(path.join(idb, 'CURRENT'), 'MANIFEST-000001\n');
    fs.mkdirSync(path.join(copyDir, 'IndexedDB', 'https_other.test_0.indexeddb.leveldb'));
    return { dir, realDir, copyDir, userDataDir, port: 1 };
}
const tree = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => {
    const p = path.join(d, f);
    return fs.statSync(p).isFile() ? `${f}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : f;
});

test('sync --dry-run changes nothing', async () => {
    const f = fakeProfiles();
    const before = [tree(f.realDir), tree(f.copyDir)];
    const out = [];
    await syncSites({ ...f, sites: ['site.test'], dryRun: true, log: (l) => out.push(l) });
    assert.deepEqual([tree(f.realDir), tree(f.copyDir)], before);
    assert.match(out.join('\n'), /would copy 1 \(file\)/);
    assert.match(out.join('\n'), /Dry run: nothing changed/);
    fs.rmSync(f.dir, { recursive: true });
});

test('sync --dry-run plans Local Storage, and a site with Local Storage only counts as matched', async () => {
    const f = fakeProfiles();
    fakeLocalStorage(f.realDir, ['https://ls-only.test', 'https://site.test']);
    const before = [tree(f.realDir), tree(f.copyDir)];
    const out = [];
    await syncSites({ ...f, sites: ['ls-only.test', 'site.test'], dryRun: true, log: (l) => out.push(l) });
    assert.deepEqual([tree(f.realDir), tree(f.copyDir)], before);
    const text = out.join('\n');
    assert.match(text, /ls-only\.test +would copy 0 \(file\) +none in real profile +would copy 1 origin \(live\)/);
    assert.match(text, /site\.test +would copy 1 \(file\) +would copy 1 \(file\) +would copy 1 origin \(live\)/);
    fs.rmSync(f.dir, { recursive: true });
});

test('sync with the window closed merges cookies and copies IndexedDB', async () => {
    const f = fakeProfiles();
    const realBefore = tree(f.realDir);
    const stale = path.join(f.copyDir, 'IndexedDB', 'https_site.test_0.indexeddb.leveldb');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'OLD'), 'stale');
    const { failed } = await syncSites({ ...f, sites: ['site.test'], log: () => {} });
    assert.equal(failed, false);
    assert.deepEqual(fs.readdirSync(stale), ['CURRENT'], 'the old folder is replaced, not merged');
    assert.deepEqual(names(path.join(f.copyDir, 'Cookies')), ['.site.test|auth', 'other.test|keep']);
    assert.deepEqual(fs.readdirSync(path.join(f.copyDir, 'IndexedDB')).sort(),
        ['https_other.test_0.indexeddb.leveldb', 'https_site.test_0.indexeddb.leveldb']);
    assert.deepEqual(tree(f.realDir), realBefore, 'the real profile is never written');
    fs.rmSync(f.dir, { recursive: true });
});

test('sync stops when a site matches nothing or the real profile is missing', async () => {
    const f = fakeProfiles();
    await assert.rejects(syncSites({ ...f, sites: ['nothing.test'], log: () => {} }), /nothing\.test matched nothing/);
    await assert.rejects(syncSites({ ...f, realDir: path.join(f.dir, 'nope'), sites: ['site.test'], log: () => {} }), /is missing/);
    fs.rmSync(f.dir, { recursive: true });
});

test('CLI: sync needs --site and a known slug', async () => {
    await assert.rejects(main(['sync', 'primary']), /--site/);
    await assert.rejects(main(['sync']), /Usage: agent-chrome sync/);
    await assert.rejects(main(['sync', 'no-such-slug-xyz', '--site', 'a.com']), /No agent-chrome profile named "no-such-slug-xyz"/);
    await assert.rejects(main(['sync', 'no-such-slug-xyz', '--site', 'not a domain']), /not a domain/);
});
