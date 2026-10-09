#!/usr/bin/env node
/**
 * pipe-cdp-proxy — multi-client WebSocket front for a single pipe-connected Chrome
 *
 * Lets multiple chrome-devtools-mcp instances (one per Claude Code session) share
 * one Chrome instance via --browserUrl. CDP traffic to Chrome flows over stdio
 * pipes (--remote-debugging-pipe), bypassing the macOS NSApplication-activation
 * bug that affects WebSocket-CDP transport (chrome-devtools-mcp#1254).
 *
 * Architecture:
 *
 *   [MCP-A] ─┐
 *   [MCP-B] ─┼── WebSocket(localhost:9410) ── Pipe Multiplexer ── stdio ── [Chrome]
 *   [MCP-C] ─┘
 *
 * State sharing:
 *   - The proxy itself enables Target discovery + auto-attach with Chrome on boot.
 *   - It caches every Target.targetCreated and Target.attachedToTarget event.
 *   - When a client calls Target.setDiscoverTargets / Target.setAutoAttach the proxy
 *     synthesizes the cached events for that client (instead of forwarding to Chrome,
 *     which would treat the call as a no-op since discovery/auto-attach is already
 *     enabled by the proxy itself).
 *   - All session-level events from Chrome are broadcast to every client. Sessions
 *     are shared across clients — race conditions on stateful commands are possible
 *     but acceptable for the typical "one primary session, others passive" workflow.
 */

import http from 'http';
import { spawn } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

const args = process.argv.slice(2);
const getArg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
};

const PROXY_PORT = parseInt(getArg('--port', '9410'));
const CHROME_PATH = getArg(
    '--chrome-path',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
);
const USER_DATA_DIR = getArg(
    '--user-data-dir',
    `${process.env.HOME}/Library/Application Support/Chrome-Pipe-Proxy`
);
const PROFILE_DIR = getArg('--profile-directory', 'Default');

// ═══════════════════════════════════════════
// Chrome process management
// ═══════════════════════════════════════════

let chromeProcess = null;
let chromeWritable = null;     // fd 3: parent → Chrome
let chromeReadable = null;     // fd 4: Chrome → parent
let chromeBuffer = Buffer.alloc(0);
let chromeReady = null;        // promise shared by everyone waiting for a lazy launch

// Launch Chrome on first use; resolves once the pipe answers and discovery is on.
// Only the user closes Chrome. Only a command that opens a tab or context launches it:
// a client that reconnects after a quit (discovery, listing) must not bring it back.
const LAUNCH_METHODS = new Set(['Target.createTarget', 'Target.createBrowserContext']);
function ensureChrome() {
    if (chromeWritable && chromeReady) return chromeReady;
    launchChrome();
    const ready = chromeReady = (async () => {
        for (let i = 0; i < 40; i++) {
            try { await cdpRequest('Browser.getVersion'); break; }
            catch { await new Promise((r) => setTimeout(r, 250)); }
        }
        await enableProxyDiscovery();
    })();
    // A late failure from an earlier launch must not clear a newer launch's promise.
    ready.catch((e) => {
        console.error('[Proxy] Chrome start failed:', e.message);
        if (chromeReady === ready) chromeReady = null;
    });
    return ready;
}

function launchChrome() {
    if (chromeProcess) return;
    console.log(`[Proxy] Launching Chrome (--user-data-dir=${USER_DATA_DIR})`);

    chromeProcess = spawn(CHROME_PATH, [
        `--user-data-dir=${USER_DATA_DIR}`,
        `--profile-directory=${PROFILE_DIR}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DialMediaRouteProvider',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        // The window sits behind the user's apps; keep its pages running at full speed.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        // No window at launch: the first tab opens a background window (see createTarget).
        '--no-startup-window',
    ], {
        stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
    });

    chromeWritable = chromeProcess.stdio[3];
    chromeReadable = chromeProcess.stdio[4];

    chromeReadable.on('data', handleChromeData);
    chromeReadable.on('error', (err) =>
        console.error('[Proxy] Chrome read error:', err.message)
    );

    let launchedAt = Date.now();
    chromeProcess.on('exit', (code, signal) => {
        const lifetime = Date.now() - launchedAt;
        console.error(
            `[Proxy] Chrome exited (code=${code}, signal=${signal}, lived ${lifetime}ms)`
        );
        chromeReady = null;
        chromeProcess = null;
        chromeWritable = null;
        chromeReadable = null;
        chromeBuffer = Buffer.alloc(0);
        knownTargets.clear();
        knownSessions.clear();
        pendingRequests.clear();
        // No auto-restart: the user quit Chrome or it crashed. Drop clients so their
        // browser handle goes stale and they reconnect on the next call (no launch).
        for (const [ws] of clientState) ws.close();
    });

    chromeProcess.on('error', (err) =>
        console.error('[Proxy] Chrome spawn error:', err.message)
    );
}

function handleChromeData(chunk) {
    chromeBuffer = Buffer.concat([chromeBuffer, chunk]);
    let nullIdx;
    while ((nullIdx = chromeBuffer.indexOf(0)) !== -1) {
        const msgBuf = chromeBuffer.subarray(0, nullIdx);
        chromeBuffer = chromeBuffer.subarray(nullIdx + 1);
        if (msgBuf.length === 0) continue;
        try {
            const msg = JSON.parse(msgBuf.toString('utf-8'));
            routeChromeMessage(msg);
        } catch (e) {
            console.error('[Proxy] Failed to parse Chrome message:', e.message);
        }
    }
}

function sendToChrome(msg) {
    if (!chromeWritable) return false;
    chromeWritable.write(JSON.stringify(msg) + '\0');
    return true;
}

// ═══════════════════════════════════════════
// State caches (shared across clients)
// ═══════════════════════════════════════════

let globalIdCounter = 1;
const pendingRequests = new Map();   // proxyId → { clientWs, originalId, method, createdAt }
const clientState = new Map();       // clientWs → { proxyIds: Set, discoveryEnabled: bool, autoAttachEnabled: bool }
const knownTargets = new Map();      // targetId → targetInfo (latest)
const knownSessions = new Map();     // sessionId → { targetInfo, waitingForDebugger }
let defaultContextId;                // Chrome's default browser context, set at each launch

function getOrCreateState(clientWs) {
    if (!clientState.has(clientWs)) {
        clientState.set(clientWs, {
            proxyIds: new Set(),
            discoveryEnabled: false,
            autoAttachEnabled: false,
        });
    }
    return clientState.get(clientWs);
}

function safeSend(ws, data) {
    if (!ws) return;
    if (typeof ws.send !== 'function') return;
    if (ws.readyState !== undefined && ws.readyState !== WebSocket.OPEN) return;
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
}

function broadcastToRealClients(msg) {
    const payload = JSON.stringify(msg);
    for (const [ws] of clientState) safeSend(ws, payload);
}

// ═══════════════════════════════════════════
// Chrome message routing
// ═══════════════════════════════════════════

// Set PROXY_DEBUG=1 in the env to trace every CDP message. Off by default
// because chatty traffic (Page.*, Runtime.*) drowns the log.
const DEBUG = process.env.PROXY_DEBUG === '1';
const dbg = (...args) => DEBUG && console.log('[Proxy.dbg]', ...args);

function routeChromeMessage(msg) {
    if (DEBUG) {
        const summary = msg.method
            ? `EVENT ${msg.method}${msg.sessionId ? ' sess=' + msg.sessionId.substring(0, 8) : ''}`
            : `RESP id=${msg.id}${msg.sessionId ? ' sess=' + msg.sessionId.substring(0, 8) : ''}${msg.error ? ' ERR=' + msg.error.message : ''}`;
        dbg('← Chrome', summary);
    }

    // Always update caches for Target.* events (regardless of routing).
    if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo) {
        knownTargets.set(msg.params.targetInfo.targetId, msg.params.targetInfo);
    } else if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo) {
        knownTargets.set(msg.params.targetInfo.targetId, msg.params.targetInfo);
    } else if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
        const wasPage = knownTargets.get(msg.params.targetId)?.type === 'page';
        knownTargets.delete(msg.params.targetId);
        if (wasPage) closeChromeIfNoPages();
    } else if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
        knownSessions.set(msg.params.sessionId, {
            targetInfo: msg.params.targetInfo,
            waitingForDebugger: msg.params.waitingForDebugger ?? false,
        });
        if (msg.params.targetInfo) {
            knownTargets.set(msg.params.targetInfo.targetId, msg.params.targetInfo);
        }
    } else if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
        knownSessions.delete(msg.params.sessionId);
    }

    // Response: route by id back to originating client.
    if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { clientWs, originalId } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        const state = clientState.get(clientWs);
        if (state) state.proxyIds.delete(msg.id);
        msg.id = originalId;
        safeSend(clientWs, msg);
        return;
    }

    // Event from Chrome: broadcast to every connected client.
    // Sessions are shared across clients (the proxy holds the only real session
    // to Chrome and exposes it to all). Clients ignore events for sessionIds they
    // don't track — Puppeteer in particular is tolerant of unknown sessions.
    if (msg.method) {
        broadcastToRealClients(msg);
    }
}

// With a context id, only pages in that browser context count: Chrome opens a tab only in a
// window of the same context, so a context without a page needs newWindow (see createTarget).
const hasPage = (contextId) => [...knownTargets.values()].some((t) =>
    t.type === 'page' && (!contextId || t.browserContextId === contextId));

// Chrome started with --no-startup-window and a debug pipe stays alive with no windows
// until a DevTools client closes it, so a Quit (Dock or Cmd+Q) leaves an empty Chrome in
// the Dock. When the last tab goes, close Chrome; the next new tab launches it again.
// The check waits a moment so a tab that a client opens at the same time can appear.
// ponytail: a tab opened later than that still races the close; that call fails and the
// next one relaunches Chrome. Add an open/close lock if that ever bites.
let closeTimer = null;
function closeChromeIfNoPages() {
    if (hasPage() || closeTimer) return;
    closeTimer = setTimeout(() => {
        closeTimer = null;
        const opening = [...pendingRequests.values()].some((r) => r.method === 'Target.createTarget');
        if (!chromeWritable || hasPage() || opening) return;
        console.log('[Proxy] Last tab closed, closing Chrome');
        cdpRequest('Browser.close').catch(() => {}); // Chrome exits before it answers
    }, 500);
}

// Stale-request reaper
setInterval(() => {
    const now = Date.now();
    for (const [proxyId, req] of pendingRequests) {
        if (now - req.createdAt > 60000) {
            safeSend(req.clientWs, {
                id: req.originalId,
                error: { code: -32000, message: 'CDP request timeout (60s)' },
            });
            pendingRequests.delete(proxyId);
            const state = clientState.get(req.clientWs);
            if (state) state.proxyIds.delete(proxyId);
        }
    }
}, 30000);

// ═══════════════════════════════════════════
// Internal CDP request (proxy-initiated, used for discovery setup + HTTP endpoints)
// ═══════════════════════════════════════════

function cdpRequest(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        if (!chromeWritable) return reject(new Error('Chrome not running'));
        const proxyId = globalIdCounter++;
        const timeout = setTimeout(() => {
            pendingRequests.delete(proxyId);
            reject(new Error(`CDP request '${method}' timed out`));
        }, 5000);
        const fakeClient = {
            send: (data) => {
                clearTimeout(timeout);
                resolve(typeof data === 'string' ? JSON.parse(data) : data);
            },
            readyState: WebSocket.OPEN,
        };
        pendingRequests.set(proxyId, {
            clientWs: fakeClient,
            originalId: proxyId,
            method,
            createdAt: Date.now(),
        });
        sendToChrome({ id: proxyId, method, params, sessionId });
    });
}

// On Chrome boot/restart: enable discovery + auto-attach so the proxy receives
// (and caches) every Target.* event, even before any real clients connect.
async function enableProxyDiscovery() {
    if (!chromeWritable) return;
    await cdpRequest('Target.setDiscoverTargets', { discover: true });
    await cdpRequest('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
    });
    defaultContextId = (await cdpRequest('Target.getBrowserContexts')).result?.defaultBrowserContextId;
    console.log('[Proxy] Discovery + auto-attach enabled by proxy itself');
}

// ═══════════════════════════════════════════
// Per-client state replay
// ═══════════════════════════════════════════

function replayDiscoveryToClient(clientWs) {
    dbg('replay discovery', knownTargets.size, 'targets');
    for (const [, targetInfo] of knownTargets) {
        safeSend(clientWs, {
            method: 'Target.targetCreated',
            params: { targetInfo },
        });
    }
}

function replayAutoAttachToClient(clientWs) {
    dbg('replay auto-attach', knownSessions.size, 'sessions');
    for (const [sessionId, { targetInfo, waitingForDebugger }] of knownSessions) {
        safeSend(clientWs, {
            method: 'Target.attachedToTarget',
            params: { sessionId, targetInfo, waitingForDebugger },
        });
    }
}

// ═══════════════════════════════════════════
// HTTP discovery endpoints
// ═══════════════════════════════════════════

// Whoever connects controls a signed-in browser, so accept local tools only, like Chrome
// does for its own debug port. Browsers send an Origin header on every WebSocket, so a web
// page that targets 127.0.0.1 is refused. A Host check stops DNS rebinding (a page on a
// domain that resolves to 127.0.0.1). chrome-devtools-mcp and Puppeteer send no Origin.
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isLocalTool(req) {
    let hostname;
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
    return LOCAL_HOSTNAMES.has(hostname) && req.headers.origin === undefined;
}

const server = http.createServer(async (req, res) => {
    if (!isLocalTool(req)) {
        res.writeHead(403);
        res.end('Forbidden: local tools only');
        return;
    }
    try {
        if (req.url === '/json/version') {
            // Mimic Chrome's /json/version so chrome-devtools-mcp's --browserUrl probe succeeds
            let version = {};
            if (chromeWritable) {
                try {
                    const result = await cdpRequest('Browser.getVersion');
                    version = result.result || {};
                } catch (e) { /* fall through with empty */ }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                Browser: version.product || 'Chrome (via Pipe CDP Proxy)',
                'Protocol-Version': version.protocolVersion || '1.3',
                'User-Agent': version.userAgent || '',
                'V8-Version': version.jsVersion || '',
                'WebKit-Version': version.product || '',
                webSocketDebuggerUrl: `ws://127.0.0.1:${PROXY_PORT}/devtools/browser/proxy`,
            }));
            return;
        }

        if (req.url === '/json/list' || req.url === '/json') {
            if (!chromeWritable) {
                res.writeHead(503);
                res.end('Chrome not running');
                return;
            }
            try {
                const result = await cdpRequest('Target.getTargets');
                const targets = (result.result?.targetInfos || []).map((t) => ({
                    ...t,
                    id: t.targetId,
                    description: '',
                    devtoolsFrontendUrl: '',
                    webSocketDebuggerUrl: `ws://127.0.0.1:${PROXY_PORT}/devtools/page/${t.targetId}`,
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(targets));
            } catch (e) {
                res.writeHead(500);
                res.end(e.message);
            }
            return;
        }

        if (req.url === '/proxy/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                chromeRunning: chromeProcess !== null,
                chromePid: chromeProcess?.pid || null,
                clients: clientState.size,
                knownTargets: knownTargets.size,
                knownSessions: knownSessions.size,
                pendingRequests: pendingRequests.size,
            }, null, 2));
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    } catch (e) {
        res.writeHead(500);
        res.end(e.message);
    }
});

// ═══════════════════════════════════════════
// WebSocket server (CDP traffic from MCP clients)
// ═══════════════════════════════════════════

const wss = new WebSocketServer({ server, verifyClient: ({ req }) => isLocalTool(req) });

wss.on('connection', (clientWs) => {
    const state = getOrCreateState(clientWs);
    console.log(`[Proxy] Client connected (total: ${clientState.size})`);

    // Handle each client's messages in arrival order, even across awaits.
    let queue = Promise.resolve();
    clientWs.on('message', (data) => {
        queue = queue.then(() => handleMessage(data))
            .catch((e) => console.error('[Proxy] Client message failed:', e.message));
    });

    async function handleMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            console.error('[Proxy] Bad client message:', e.message);
            return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (chromeProcess || LAUNCH_METHODS.has(msg.method)) {
            await ensureChrome().catch(() => {});
        }

        // Intercept discovery + auto-attach so each client gets a fresh stream
        // of Target.targetCreated / Target.attachedToTarget events for state
        // that already existed when it connected. Forwarding to Chrome would
        // be a no-op (the proxy itself already enabled discovery + auto-attach).
        // Intercept browser-level (no sessionId) discovery + auto-attach so the
        // client sees the cached state. Per-session calls (sessionId set) are
        // session-scoped (e.g., iframe auto-attach within a target) and must be
        // forwarded normally — intercepting them caused infinite replay loops.
        if (msg.method === 'Target.setDiscoverTargets' && !msg.sessionId) {
            const enable = msg.params?.discover === true;
            state.discoveryEnabled = enable;
            // Match Chrome's ordering: emit initial targetCreated events first,
            // then respond. Puppeteer captures the events then resolves on response.
            if (enable) replayDiscoveryToClient(clientWs);
            if (msg.id !== undefined) {
                safeSend(clientWs, { id: msg.id, result: {} });
            }
            return;
        }
        if (msg.method === 'Target.setAutoAttach' && !msg.sessionId) {
            const enable = msg.params?.autoAttach === true;
            state.autoAttachEnabled = enable;
            if (enable) replayAutoAttachToClient(clientWs);
            if (msg.id !== undefined) {
                safeSend(clientWs, { id: msg.id, result: {} });
            }
            return;
        }

        // Chrome is down: let a connect succeed with no contexts, refuse the rest.
        if (!chromeWritable) {
            if (msg.id === undefined) return;
            safeSend(clientWs, msg.method === 'Target.getBrowserContexts'
                ? { id: msg.id, result: { browserContextIds: [] } }
                : { id: msg.id, error: { code: -1, message: 'Chrome not running' } });
            return;
        }

        // Keep Chrome from activating: foreground tabs, bringToFront and activateTarget pull
        // Chrome.app forward and switch macOS Spaces even over the pipe.
        if (msg.method === 'Page.bringToFront' || msg.method === 'Target.activateTarget') {
            if (msg.id !== undefined) safeSend(clientWs, { id: msg.id, result: {}, sessionId: msg.sessionId });
            return;
        }
        if (msg.method === 'Target.createTarget') {
            const contextId = msg.params?.browserContextId ?? defaultContextId;
            msg.params = { ...msg.params, background: true, newWindow: !hasPage(contextId) };
        }
        // Tabs are shared: an earlier client may already have Runtime enabled on this
        // session, and a repeat enable reports no execution contexts. Reset it first.
        if (msg.method === 'Runtime.enable' && msg.sessionId) {
            await cdpRequest('Runtime.disable', {}, msg.sessionId).catch(() => {});
        }

        // ID remap so multiple clients don't collide on Chrome's request IDs.
        const origId = msg.id;
        if (msg.id !== undefined) {
            const proxyId = globalIdCounter++;
            pendingRequests.set(proxyId, {
                clientWs,
                originalId: msg.id,
                method: msg.method,
                createdAt: Date.now(),
            });
            state.proxyIds.add(proxyId);
            msg.id = proxyId;
        }

        dbg('→ Chrome', `${msg.method}${msg.sessionId ? ' sess=' + msg.sessionId.substring(0, 8) : ''} (cid=${origId} pid=${msg.id})`);
        sendToChrome(msg);
    }

    const cleanup = () => {
        for (const pid of state.proxyIds) pendingRequests.delete(pid);
        clientState.delete(clientWs);
        console.log(`[Proxy] Client disconnected (remaining: ${clientState.size})`);
    };

    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);
});

// ═══════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════

process.on('uncaughtException', (err) =>
    console.error('[Proxy] Uncaught exception:', err.message, err.stack)
);
process.on('unhandledRejection', (reason) =>
    console.error('[Proxy] Unhandled rejection:', reason)
);

function shutdown() {
    console.log('[Proxy] Shutting down');
    try { chromeProcess?.kill('SIGTERM'); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[Proxy] Listening on http://127.0.0.1:${PROXY_PORT} (Chrome starts on first new tab)`);
});
