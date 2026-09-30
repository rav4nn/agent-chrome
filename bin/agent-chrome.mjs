#!/usr/bin/env node
// agent-chrome: set up copies of your signed-in Chrome profiles that Claude Code drives
// through pipe-cdp-proxy, in background windows that never take focus (macOS).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HOME = os.homedir();
export const CHROME_ROOT = path.join(HOME, 'Library/Application Support/Google/Chrome');
export const HOME_DIR = path.join(HOME, 'Library/Application Support/agent-chrome');
const RUNTIME_DIR = path.join(HOME_DIR, 'runtime');
const PROFILES_DIR = path.join(HOME_DIR, 'profiles');
export const LOG_DIR = path.join(HOME, 'Library/Logs/agent-chrome');
export const LABEL_PREFIX = 'io.github.rav4nn.agent-chrome.';
const AGENTS_DIR = path.join(HOME, 'Library/LaunchAgents');
export const BASE_PORT = 9410;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CHROME_BIN = 'Google Chrome.app/Contents/MacOS/Google Chrome';
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FILES = ['pipe-cdp-proxy.mjs', 'package.json'];

const USAGE = `Usage: agent-chrome <command>

  profiles                      List your Chrome profiles and which ones are set up.
  add <profile> [options]       Copy a profile, start its proxy at login, register its MCP server.
      --name <slug>             Server name suffix (default: from the profile's name).
      --port <n>                Proxy port (default: first free port from ${BASE_PORT}).
      --color <#rrggbb>         Theme colour of the agent window (default: #D50000).
      --recopy                  Replace an existing copy with a fresh one.
      --force                   Copy even while Chrome is running.
      --dry-run                 Print the plan. Change nothing.
  remove <slug> [--delete-profile] [--dry-run]
                                Stop the proxy and unregister the server. Keeps the copy
                                unless you pass --delete-profile.
  status                        Show each installed profile's proxy, window and server.
  update [--dry-run]            Refresh the proxy code and restart every proxy.

<profile> is a profile folder ("Profile 5"), display name or email.`;

// ─── Pure helpers (exported for tests) ───

export function listProfiles(infoCache) {
    return Object.entries(infoCache ?? {}).map(([dir, v]) => ({
        dir,
        name: v?.name ?? '',
        email: v?.user_name ?? '',
    }));
}

// Every profile whose folder, display name or email equals the query (case-insensitive).
export function resolveProfile(profiles, query) {
    const q = query.toLowerCase();
    return profiles.filter((p) => [p.dir, p.name, p.email].some((v) => v && v.toLowerCase() === q));
}

export const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// "#D50000" → -2818048: opaque ARGB as the signed 32-bit int Chrome stores.
export function argbFromHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`"${hex}" is not a colour. Use #rrggbb, for example #D50000.`);
    return (0xff000000 | parseInt(m[1], 16)) | 0;
}

// The copy is its own sync device. Synced themes would push the agent colour back into
// the real profile, and agent history, tabs and extensions would pollute the real one.
export function prefsPatch(argb) {
    return {
        theme: { user_color: argb, user_color2: argb, color_variant: 3, color_variant2: 3, color_scheme2: 0 },
        sync: {
            keep_everything_synced: false,
            themes: false, typed_urls: false, tabs: false, saved_tab_groups: false, extensions: false, apps: false,
        },
    };
}

export function patchPreferences(prefs, argb) {
    const { theme, sync } = prefsPatch(argb);
    prefs.browser = { ...prefs.browser, theme: { ...prefs.browser?.theme, ...theme } };
    delete prefs.browser.theme.is_grayscale;
    delete prefs.browser.theme.is_grayscale2;
    prefs.sync = { ...prefs.sync, ...sync };
    return prefs;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function renderPlist({ label, args, log }) {
    const str = (v) => `<string>${xmlEscape(v)}</string>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${str(label)}
\t<key>ProgramArguments</key>
\t<array>
${args.map((a) => `\t\t${str(a)}`).join('\n')}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t${str(log)}
\t<key>StandardErrorPath</key>
\t${str(log)}
</dict>
</plist>
`;
}

// Reads back what renderPlist wrote. The plist is the only state agent-chrome keeps.
export function parsePlist(xml) {
    const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? '';
    const args = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlUnescape(m[1]));
    const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
    return {
        label: label === undefined ? undefined : xmlUnescape(label),
        args,
        port: Number(flag('--port')),
        userDataDir: flag('--user-data-dir'),
        profileDir: flag('--profile-directory'),
    };
}

export async function choosePort(used, isFree, start = BASE_PORT) {
    for (let p = start; p <= 65535; p++) if (!used.has(p) && (await isFree(p))) return p;
    throw new Error(`No free port from ${start}. Pass --port.`);
}

// The user's own Chrome: the main process (no --type=) on Chrome's default data dir.
export function isRealChromeMain(line, chromeRoot = CHROME_ROOT) {
    if (!line.includes(CHROME_BIN) || line.includes('--type=')) return false;
    const dir = /--user-data-dir=(.+?)(?= --|$)/.exec(line)?.[1];
    return !dir || path.resolve(dir) === path.resolve(chromeRoot);
}

// ─── Side effects: everything below prints what it does; --dry-run only prints ───

let DRY = false;
const say = (...a) => console.log(...a);
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replaceAll("'", `'\\''`)}'`);
const indent = (text) => text.trimEnd().split('\n').map((l) => `    ${l}`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => { throw new Error(msg); };

// A state check that would stop a real run. A dry run notes it and carries on.
function stop(msg) {
    if (!DRY) die(msg);
    say(`(dry run) a real run stops here: ${msg}`);
}

function step(desc, fn) {
    say(desc);
    if (!DRY) fn();
}

function run(cmd, args, { cwd, allowFail = false } = {}) {
    const line = [cmd, ...args].map(quote).join(' ');
    say(`$ ${cwd ? `(cd ${quote(cwd)}) ` : ''}${line}`);
    if (DRY) return true;
    try {
        execFileSync(cmd, args, { cwd, stdio: allowFail ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
        return true;
    } catch (e) {
        if (allowFail) return false;
        throw new Error(`${line} failed (exit ${e.status ?? e.code}).`);
    }
}

// Read-only command: true when it exits 0. Runs in dry runs too.
function succeeds(cmd, args) {
    try {
        execFileSync(cmd, args, { stdio: 'ignore', timeout: 30000 });
        return true;
    } catch {
        return false;
    }
}

function which(cmd) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, cmd);
        try {
            fs.accessSync(p, fs.constants.X_OK);
            if (fs.statSync(p).isFile()) return p;
        } catch { /* not here */ }
    }
    return null;
}

// Prefer a stable PATH entry (/opt/homebrew/bin/node) over process.execPath, which points
// into a versioned Cellar folder that a Homebrew upgrade deletes.
function nodePath() {
    const onPath = which('node');
    try {
        if (onPath && fs.realpathSync(onPath) === fs.realpathSync(process.execPath)) return onPath;
    } catch { /* fall through */ }
    return process.execPath;
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

function readProfiles() {
    const raw = readText(path.join(CHROME_ROOT, 'Local State'));
    if (!raw) die(`Chrome's Local State is missing from ${CHROME_ROOT}. Install Google Chrome and open it once.`);
    return listProfiles(JSON.parse(raw).profile?.info_cache);
}

function listInstalled() {
    let names = [];
    try { names = fs.readdirSync(AGENTS_DIR); } catch { /* no LaunchAgents folder yet */ }
    return names
        .filter((n) => n.startsWith(LABEL_PREFIX) && n.endsWith('.plist'))
        .map((n) => {
            const file = path.join(AGENTS_DIR, n);
            const slug = n.slice(LABEL_PREFIX.length, -'.plist'.length);
            return { slug, label: LABEL_PREFIX + slug, file, ...parsePlist(fs.readFileSync(file, 'utf8')) };
        });
}

const portFree = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
});

async function proxyStatus(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/proxy/status`, { signal: AbortSignal.timeout(1000) });
        return await res.json();
    } catch {
        return null;
    }
}

function realChromeRunning() {
    return execFileSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' })
        .split('\n').some((line) => isRealChromeMain(line));
}

function table(rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    for (const r of rows) say(r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
}

function printProfiles(profiles, installed) {
    const slugs = (dir) => installed.filter((i) => i.profileDir === dir).map((i) => i.slug).join(', ');
    table([['PROFILE', 'NAME', 'EMAIL', 'SET UP AS'], ...profiles.map((p) => [p.dir, p.name, p.email, slugs(p.dir)])]);
}

const uid = () => process.getuid();
const serverName = (slug) => `chrome-${slug}`;

// The LaunchAgent needs a path that outlives an npx or plugin cache, so the proxy runs
// from its own copy under HOME_DIR.
function installRuntime() {
    const srcPkg = readText(path.join(PKG_ROOT, 'package.json'));
    const oldPkg = readText(path.join(RUNTIME_DIR, 'package.json'));
    step(`$ mkdir -p ${quote(RUNTIME_DIR)}`, () => fs.mkdirSync(RUNTIME_DIR, { recursive: true }));
    for (const f of RUNTIME_FILES) {
        const src = path.join(PKG_ROOT, f);
        const dst = path.join(RUNTIME_DIR, f);
        if (readText(src) !== readText(dst)) step(`$ cp ${quote(src)} ${quote(dst)}`, () => fs.copyFileSync(src, dst));
    }
    if (!fs.existsSync(path.join(RUNTIME_DIR, 'node_modules/ws')) || srcPkg !== oldPkg) {
        run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: RUNTIME_DIR });
    }
}

// ─── Commands ───

async function cmdAdd(query, o) {
    const profiles = readProfiles();
    const hits = resolveProfile(profiles, query);
    if (hits.length !== 1) {
        console.error(hits.length
            ? `"${query}" matches ${hits.length} profiles. Use the PROFILE folder name.`
            : `No Chrome profile matches "${query}".`);
        printProfiles(profiles, listInstalled());
        process.exitCode = 1;
        return;
    }
    const profile = hits[0];
    const slug = o.name ?? slugify(profile.name);
    if (!SLUG_RE.test(slug)) die(`"${slug}" is not a valid name. Pass --name with lowercase letters, digits and hyphens.`);
    const argb = argbFromHex(o.color ?? '#D50000');
    if (o.port !== undefined && !(/^\d+$/.test(o.port) && +o.port >= 1024 && +o.port <= 65535)) {
        die(`--port must be a number from 1024 to 65535, not "${o.port}".`);
    }

    const installed = listInstalled();
    const mine = installed.find((i) => i.slug === slug);
    const copyDir = path.join(PROFILES_DIR, slug);
    const copyExists = fs.existsSync(copyDir);
    const label = LABEL_PREFIX + slug;
    const plistFile = path.join(AGENTS_DIR, `${label}.plist`);
    const server = serverName(slug);

    if (mine && mine.profileDir !== profile.dir) {
        die(`"${slug}" is already set up for ${mine.profileDir}. Pick another --name.`);
    }
    if (copyExists && !fs.existsSync(path.join(copyDir, profile.dir))) {
        die(`${copyDir} holds a copy of another profile. Pick another --name, or run: agent-chrome remove ${slug} --delete-profile`);
    }

    const usedByOthers = new Set(installed.filter((i) => i !== mine).map((i) => i.port));
    let port;
    if (o.port !== undefined) {
        port = +o.port;
        if (usedByOthers.has(port)) die(`Port ${port} belongs to another agent-chrome profile. Pick another --port.`);
        if (port !== mine?.port && !(await portFree(port))) die(`Port ${port} is in use. Pick another --port.`);
    } else {
        port = mine?.port || (await choosePort(usedByOthers, portFree));
    }

    // The proxy restarts below, which closes the agent window and would lose the theme patch.
    if (mine && (await proxyStatus(mine.port))?.chromeRunning) {
        stop(`The agent window for ${slug} is open. Quit it (Cmd+Q in that window), then run add again.`);
    }
    const copy = !copyExists || o.recopy;
    if (copy && realChromeRunning()) {
        if (!o.force) stop('Chrome is running. Quit Chrome (Cmd+Q) for a clean copy, or pass --force.');
        else say('Warning: Chrome is running. Its live databases may copy in a mixed state, and the copy can lose sign-ins.');
    }
    const claude = which('claude');
    if (claude && !mine && succeeds(claude, ['mcp', 'get', server])) {
        stop(`An MCP server named ${server} already exists and agent-chrome did not create it. Pick another --name.`);
    }

    say(`\nRuntime`);
    installRuntime();

    say(`\nProfile copy`);
    if (copy) {
        const src = path.join(CHROME_ROOT, profile.dir);
        if (!fs.existsSync(src)) die(`${src} does not exist. Open that profile in Chrome once, then try again.`);
        // Copy into a staging folder, so a failed copy never replaces the old one or
        // leaves a half copy that a later add would reuse. Slugs have no dots: no clash.
        const stage = `${copyDir}.new`;
        const rmrf = (dir) => step(`$ rm -rf ${quote(dir)}`, () => fs.rmSync(dir, { recursive: true, force: true }));
        rmrf(stage);
        step(`$ mkdir -p ${quote(stage)}`, () => fs.mkdirSync(stage, { recursive: true }));
        run('cp', ['-cR', path.join(CHROME_ROOT, 'Local State'), stage]);
        run('cp', ['-cR', src, stage]);
        if (copyExists) rmrf(copyDir);
        step(`$ mv ${quote(stage)} ${quote(copyDir)}`, () => fs.renameSync(stage, copyDir));
    } else {
        say(`Reusing ${copyDir} (pass --recopy for a fresh copy).`);
    }

    const prefsFile = path.join(copyDir, profile.dir, 'Preferences');
    const backup = path.join(copyDir, profile.dir, 'Preferences.agent-chrome.bak');
    const patch = prefsPatch(argb);
    step(`patch ${quote(prefsFile)} (first backup: ${path.basename(backup)})
    browser.theme += ${JSON.stringify(patch.theme)}, minus is_grayscale, is_grayscale2
    sync += ${JSON.stringify(patch.sync)}`, () => {
        const raw = fs.readFileSync(prefsFile, 'utf8');
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
        fs.writeFileSync(prefsFile, JSON.stringify(patchPreferences(JSON.parse(raw), argb)));
    });

    say(`\nLaunchAgent`);
    const log = path.join(LOG_DIR, `${slug}.log`);
    const xml = renderPlist({
        label,
        log,
        args: [nodePath(), path.join(RUNTIME_DIR, 'pipe-cdp-proxy.mjs'), '--port', String(port),
            '--user-data-dir', copyDir, '--profile-directory', profile.dir],
    });
    step(`$ mkdir -p ${quote(LOG_DIR)}`, () => fs.mkdirSync(LOG_DIR, { recursive: true }));
    step(`write ${plistFile}${DRY ? `\n${indent(xml)}` : ''}`, () => {
        fs.mkdirSync(AGENTS_DIR, { recursive: true });
        fs.writeFileSync(plistFile, xml);
    });
    const domain = `gui/${uid()}`;
    run('launchctl', ['bootout', `${domain}/${label}`], { allowFail: true });
    // ponytail: fixed retry. launchd can still be tearing down the old job right after bootout.
    for (let i = 0; !run('launchctl', ['bootstrap', domain, plistFile], { allowFail: i < 2 }); i++) await sleep(1000);

    say(`\nMCP server`);
    const mcp = which('chrome-devtools-mcp');
    const command = [...(mcp ? [mcp] : ['npx', '-y', 'chrome-devtools-mcp@latest']),
        '--browserUrl', `http://127.0.0.1:${port}`, '--no-usage-statistics', '--no-performance-crux'];
    if (claude) {
        run(claude, ['mcp', 'remove', '-s', 'user', server], { allowFail: true });
        run(claude, ['mcp', 'add', '-s', 'user', server, '--', ...command]);
    } else {
        say(`The claude CLI is not on PATH. Add this under "mcpServers" in ~/.claude.json:`);
        say(indent(JSON.stringify({ [server]: { type: 'stdio', command: command[0], args: command.slice(1) } }, null, 2)));
    }

    say(`
${DRY ? 'Dry run: nothing changed.' : 'Done.'}
  MCP server    ${server}
  Port          ${port}
  Profile copy  ${copyDir}
Start a new Claude Code session (or resume one) to load the server. The agent window opens on the first new tab.`);
}

function cmdRemove(slug, o) {
    if (!SLUG_RE.test(slug)) die(`"${slug}" is not a valid name. Run agent-chrome status to see installed names.`);
    const label = LABEL_PREFIX + slug;
    const plistFile = path.join(AGENTS_DIR, `${label}.plist`);
    const copyDir = path.join(PROFILES_DIR, slug);
    if (fs.existsSync(plistFile)) {
        // A loaded job must stop before its plist goes, or the proxy runs on unseen by status.
        const target = `gui/${uid()}/${label}`;
        if (succeeds('launchctl', ['print', target])) run('launchctl', ['bootout', target]);
        step(`$ rm ${quote(plistFile)}`, () => fs.rmSync(plistFile));
    } else {
        say(`No LaunchAgent for ${slug}.`);
    }
    const claude = which('claude');
    if (claude) run(claude, ['mcp', 'remove', '-s', 'user', serverName(slug)], { allowFail: true });
    else say(`The claude CLI is not on PATH. Remove "${serverName(slug)}" from ~/.claude.json yourself.`);
    if (fs.existsSync(copyDir)) {
        if (o['delete-profile']) step(`$ rm -rf ${quote(copyDir)}`, () => fs.rmSync(copyDir, { recursive: true, force: true }));
        else say(`Kept the profile copy at ${copyDir}. Pass --delete-profile to delete it.`);
    }
    if (DRY) say('Dry run: nothing changed.');
}

async function cmdStatus() {
    const claude = which('claude');
    const rows = [['SLUG', 'PORT', 'PROFILE', 'PROXY', 'WINDOW', 'MCP']];
    for (const i of listInstalled()) {
        const st = await proxyStatus(i.port);
        const mcp = claude ? (succeeds(claude, ['mcp', 'get', serverName(i.slug)]) ? 'registered' : 'missing') : 'unknown';
        rows.push([i.slug, i.port, i.profileDir ?? '?', st ? 'up' : 'down', st ? (st.chromeRunning ? 'open' : 'closed') : '-', mcp]);
    }
    table(rows);
}

function cmdUpdate() {
    installRuntime();
    const installed = listInstalled();
    if (!installed.length) say('No agent-chrome profiles installed.');
    for (const i of installed) run('launchctl', ['kickstart', '-k', `gui/${uid()}/${i.label}`]);
    if (DRY) say('Dry run: nothing changed.');
}

export async function main(argv) {
    const { values: o, positionals: [cmd, arg, ...extra] } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            name: { type: 'string' },
            port: { type: 'string' },
            color: { type: 'string' },
            force: { type: 'boolean' },
            recopy: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            'delete-profile': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (o.help || !cmd) return say(USAGE);
    if (process.platform !== 'darwin') die('agent-chrome runs on macOS only.');
    if (extra.length) die(`Too many arguments: ${extra.join(' ')}. Quote a profile name that has spaces.`);
    DRY = Boolean(o['dry-run']);
    switch (cmd) {
        case 'profiles': return printProfiles(readProfiles(), listInstalled());
        case 'add': return arg ? cmdAdd(arg, o) : die('Usage: agent-chrome add <profile>. Run agent-chrome profiles to list them.');
        case 'remove': return arg ? cmdRemove(arg, o) : die('Usage: agent-chrome remove <slug>. Run agent-chrome status to list them.');
        case 'status': return cmdStatus();
        case 'update': return cmdUpdate();
        default: die(`Unknown command "${cmd}". Run agent-chrome --help.`);
    }
}

const isEntry = (() => {
    try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntry) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(`agent-chrome: ${e.message}`);
        process.exitCode = 1;
    });
}
