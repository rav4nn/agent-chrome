# chrome-pipe-proxy

A small Node.js daemon that owns one Chrome instance over `--remote-debugging-pipe` and exposes a multiplexed WebSocket CDP endpoint to many [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) clients (one per Claude Code / Cursor / Cline / etc. session).

Specifically a workaround for [chrome-devtools-mcp#1254](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254) — the Chromium bug where every CDP message over WebSocket triggers `NSApplication` activation on macOS, yanking focus from your terminal.

```
[MCP-A] ─┐
[MCP-B] ─┼── WebSocket(localhost:9410) ── chrome-pipe-proxy ── stdio pipe ── [Chrome]
[MCP-C] ─┘
```

> **Status:** personal-use workaround. Built in an afternoon to solve my own setup. MIT-licensed, but **not actively maintained** — I'll happily accept PRs but I'm not committing to keep it working as Chrome / chrome-devtools-mcp evolve. If issue #1254 gets a real upstream fix, this becomes obsolete and I'll archive the repo.

## Why this exists

Without it, on macOS you have to pick between two bad options for `chrome-devtools-mcp`:

- **`--autoConnect` to a port-mode Chrome.** Multi-session sharing works (multiple MCP sessions can attach to one Chrome and inherit your real auth). But every CDP message steals macOS focus from your terminal/IDE — the WebSocket-CDP transport activates Chrome.app, and there's no `bringToFront: false` workaround that helps because the activation is in the transport layer, not gated on specific methods.
- **Standalone (no `--autoConnect`), pipe transport.** No focus theft (pipe doesn't trigger the activation bug). But pipes are parent-child IPC, so only the launching MCP can hold them. Two parallel Claude Code sessions either fight over the user-data-dir lock or each spawn their own ephemeral Chrome with no shared state — and you re-sign-in every session if you weren't OK with the ephemeral profile.

Neither is acceptable for "the agent drives my browser, all day, while I work in the terminal."

This proxy combines the good halves: pipe transport (no focus theft) + a long-lived daemon owning the single pipe (so multiple MCP sessions can share one Chrome with persistent auth).

## How the multiplexing works

The daemon launches Chrome via `--remote-debugging-pipe`, which exposes a JSON-over-stdio CDP channel only to the launching parent process. The daemon then presents a localhost HTTP+WebSocket interface that mimics Chrome's `--remote-debugging-port` discovery format (`/json/version`, `/json/list`, browser-level WebSocket), so `chrome-devtools-mcp --browserUrl http://127.0.0.1:9410` connects without knowing it isn't talking to Chrome directly.

Two routing patterns make many MCP clients safely share one pipe:

- **Request-ID remapping.** Each client picks ids `1, 2, 3, ...` independently and they would collide on the upstream pipe. The daemon rewrites every incoming `id` to a globally unique proxy id, records the mapping `proxyId → {client, originalId, method}`, forwards to Chrome, and on the response restores the original id before sending to the originating client.
- **Per-session event routing.** When a client calls `Target.attachToTarget`, Chrome's response includes a `sessionId`; the daemon records which client owns that session. Subsequent CDP events from Chrome carry the `sessionId`, so they're routed to the owning client only (not broadcast). This is how each Claude Code session ends up with its own logical view of Chrome — they share the underlying browser but their tab/session state is independent.

That's the whole architecture. ~250 LOC of Node.js, single dependency on `ws`, localhost-only, no telemetry.

## Quick start

```bash
git clone https://github.com/mimkorn/chrome-pipe-proxy.git
cd chrome-pipe-proxy
npm install --ignore-scripts

# Run — point at a NON-DEFAULT user-data-dir (see Caveats):
node pipe-cdp-proxy.mjs \
  --user-data-dir "$HOME/Library/Application Support/Chrome-Pipe-Proxy"
```

In your `~/.claude.json` (or wherever you configure MCP servers):

```json
{
  "mcpServers": {
    "chrome-devtools-real": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--browserUrl",
        "http://127.0.0.1:9410"
      ]
    }
  }
}
```

First time the daemon launches Chrome, it'll be a fresh profile — sign in to the services your agent needs (Google, etc.) once. Auth persists.

For at-login startup, see [the LaunchAgent example](#launchagent-macos).

## Configuration

| Flag | Default | Description |
|---|---|---|
| `--port` | `9410` | Port the proxy listens on for MCP clients. |
| `--chrome-path` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Path to the Chrome binary. |
| `--user-data-dir` | `$HOME/Library/Application Support/Chrome-Pipe-Proxy` | Chrome profile dir. **Must NOT** be Chrome's default — see Caveats. |

Status / health check:

```bash
curl -s http://127.0.0.1:9410/proxy/status | jq
```

## LaunchAgent (macOS)

Drop this at `~/Library/LaunchAgents/com.you.chrome-pipe-proxy.plist`, replacing paths as needed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.you.chrome-pipe-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/path/to/chrome-pipe-proxy/pipe-cdp-proxy.mjs</string>
        <string>--user-data-dir</string>
        <string>/Users/you/Library/Application Support/Chrome-Pipe-Proxy</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/Users/you/logs/chrome-pipe-proxy-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/logs/chrome-pipe-proxy-stderr.log</string>
</dict>
</plist>
```

Load with `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.you.chrome-pipe-proxy.plist`.

## Caveats

- **Don't point `--user-data-dir` at Chrome's default profile location** (`~/Library/Application Support/Google/Chrome` on macOS). Chrome silently refuses to expose CDP — pipe or port — when the data directory is its default. The runtime stderr message is `DevTools remote debugging requires a non-default data directory.` This is *separate* from the Chrome 136+ stored-credentials port restriction; it applies to pipe transport too. Cost: a one-time sign-in to whatever services the agent needs to access, in a dedicated profile dir.
- **Single Chrome instance is shared across all MCP clients.** No isolation between sessions in this proxy — they all see the same tabs and can step on each other if they're driving the same target. Per-session isolation would need a `Target.createTarget` ownership tracker (the existing chrome-mcp-proxy does this; would be a small addition here).
- **Auto-restart guard:** if Chrome dies in under 3 seconds, the proxy does NOT auto-restart it (treats short-lived exit as a config error rather than a transient crash). This guard exists because an early version without it spawned ~20 Chrome windows in a loop when I'd misconfigured `--user-data-dir`. The guard stays.
- **Local tools only.** Whoever connects controls a signed-in browser, so the proxy refuses any request with an `Origin` header (browsers send one on every WebSocket, so a web page can't connect to `127.0.0.1`) and any `Host` other than `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding). chrome-devtools-mcp and Puppeteer send no `Origin`. Other programs on your Mac can still connect, the same as with Chrome's own debug port. `npm test` checks this without starting Chrome.
- **No Windows / Linux testing.** macOS-focused, since macOS is where the focus-theft bug bites. The pipe-multiplexer architecture works on any platform but I haven't tried.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

Multi-client routing patterns (request-ID remapping, per-session event ownership) are taken structurally from [henu-wang/chrome-mcp-proxy](https://github.com/henu-wang/chrome-mcp-proxy), which solves a different shape of the same problem with a WebSocket-to-WebSocket filter proxy. That proxy doesn't help with `chrome-devtools-mcp@latest` (the methods it filters aren't being sent in the first place — see [chrome-devtools-mcp#1254 comment thread](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254) for the empirical confirmation), but the multi-client mechanics are sound.
