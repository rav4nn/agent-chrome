# agent-chrome

Claude Code drives copies of your signed-in Chrome profiles. Each copy runs in its own window that opens behind your other apps and never takes focus, so you keep typing in the terminal while the agent browses as you. macOS only.

agent-chrome is a fork of [mimkorn/chrome-pipe-proxy](https://github.com/mimkorn/chrome-pipe-proxy). The proxy is the same idea. This fork adds a setup CLI, a Claude Code plugin and a few proxy changes (listed below).

```
[Claude session A] chrome-devtools-mcp ─┐
[Claude session B] chrome-devtools-mcp ─┼── WebSocket(127.0.0.1:9410) ── proxy ── stdio pipe ── [Chrome, profile copy]
[Claude session C] chrome-devtools-mcp ─┘
```

## Install

You need macOS, Google Chrome, Node 18.3 or later, and Claude Code. Quit Chrome (Cmd+Q) before you add a profile, so the copy is clean.

Pick one route.

1. **Claude Code plugin.** In Claude Code, run:

   ```
   /plugin marketplace add rav4nn/agent-chrome
   /plugin install agent-chrome@agent-chrome
   ```

   Then ask Claude to set up agent-chrome for one of your Chrome profiles. The plugin's skill runs the CLI for you, and later tells Claude how to use the browser tools.

2. **npx.** No clone needed:

   ```bash
   npx github:rav4nn/agent-chrome profiles
   npx github:rav4nn/agent-chrome add "Work"
   ```

3. **Clone.**

   ```bash
   git clone https://github.com/rav4nn/agent-chrome.git
   cd agent-chrome
   node bin/agent-chrome.mjs profiles
   node bin/agent-chrome.mjs add "Work"
   ```

After `add`, start a new Claude Code session (or resume one). The agent window opens on the first new tab.

Installing the plugin alone gives Claude no browser yet. The browser tools appear after `add` and a new session.

## Ask Claude

Each profile you set up is an MCP server named `chrome-<slug>`, for example `chrome-work`. Name it in your prompt, and Claude uses that profile.

| Step | Prompt |
| --- | --- |
| Set up (plugin route) | `Set up agent-chrome for one of my Chrome profiles.` |
| First test, in a new session | `Open chrome-work and go to myaccount.google.com. Tell me which Google account is signed in. Don't click or change anything.` |
| Everyday use | `Open chrome-work and go to reddit.com. Open the first 3 posts and summarise them.` |

While the first test runs, keep typing in your terminal. The terminal stays in front, and the agent window (the one with the coloured theme) opens behind it.

Then quit the agent window from the Dock and ask again: `Open chrome-work and go to example.com.` The window comes back behind your apps, still signed in.

Always name the profile. Each one is signed in to different accounts, and without a name Claude asks which one you mean.

## What `add` does

1. Copies the profile into `~/Library/Application Support/agent-chrome/profiles/<slug>/`. It uses an APFS clone, so the copy is fast and takes no extra disk space until the two drift apart.
2. Gives the copy a coloured theme (default `#D50000`), so you can tell the agent window from yours.
3. Turns off sync in the copy for themes, typed URLs, tabs, tab groups, extensions and apps. The copy is its own sync device. Synced themes would push the agent colour back into your real profile, and agent history would land in it.
4. Installs the proxy in `~/Library/Application Support/agent-chrome/runtime/` and a LaunchAgent, `io.github.rav4nn.agent-chrome.<slug>`, that starts it at login through a small launcher, `launchers/agent-chrome-<slug>`. Logs go to `~/Library/Logs/agent-chrome/<slug>.log`.

   macOS then shows "agent-chrome-<slug> can run in the background". That is the proxy for that profile. It starts at login so the agent window can open when Claude asks for it, and it uses about 25 MB of RAM and no CPU while it waits. Activity Monitor lists it as `node`. You can turn it off in System Settings > General > Login Items & Extensions, but then Claude can't open that profile. `agent-chrome remove <slug>` removes it completely.
5. Registers a user-scope MCP server, `chrome-<slug>`: chrome-devtools-mcp pointed at the proxy's port. It uses your global `chrome-devtools-mcp` if you have one, and `npx chrome-devtools-mcp@latest` if not. Without the `claude` CLI on your PATH, it prints the JSON to paste into `~/.claude.json`.

Add `--dry-run` to see every file write and command without running any of them.

## Commands

| Command | What it does |
| --- | --- |
| `profiles` | Lists your Chrome profiles (folder, name, email) and the slug of each one you've set up |
| `add <profile>` | Sets up a profile. `<profile>` is its folder (`"Profile 5"`), display name or email |
| `remove <slug>` | Stops the proxy, deletes its LaunchAgent and unregisters the MCP server. Keeps the copy |
| `status` | One row per installed slug: port, proxy up, agent window open, MCP server registered |
| `update` | Refreshes the proxy code in the runtime folder and restarts every proxy |

Options for `add`:

| Option | Default | Meaning |
| --- | --- | --- |
| `--name <slug>` | the profile's name, lowercased, with hyphens | MCP server is `chrome-<slug>` |
| `--port <n>` | first free port from 9410 | Proxy port |
| `--color <#rrggbb>` | `#D50000` | Theme colour of the agent window |
| `--recopy` | off | Replace an existing copy with a fresh one from your real profile |
| `--force` | off | Copy while Chrome is running. Live databases may copy in a mixed state, and the copy can lose sign-ins |
| `--dry-run` | off | Print the plan, change nothing |

`remove` takes `--delete-profile` to delete the copy too, and `--dry-run`. `update` takes `--dry-run`.

Running `add` again for the same profile is safe. It keeps the existing copy and port, and rewrites the theme, LaunchAgent and MCP server.

## Using it from Claude

- The tools are `mcp__chrome-<slug>__*`, from chrome-devtools-mcp.
- Open pages with `new_page` and `background: true`. The first new tab starts Chrome.
- Each session works only in the tabs it opened. Sessions share one window, so this keeps them out of each other's way.
- Only you close the agent window. After you quit it, the tools report no pages. The next `new_page` opens it again.
- When the last agent tab closes (Quit, the window's close button, or the last tab), the proxy exits that Chrome, so no empty Chrome stays in the Dock.
- If a site shows you signed out, sign in inside the agent window.

The plugin's skill tells Claude all of this.

## Changes from upstream

- `--profile-directory` picks the Chrome profile inside `--user-data-dir`.
- Chrome starts only when a client opens a tab or browser context. A connect, a discovery call or a page list while Chrome is down gets an empty browser, not a launch.
- No auto-restart. When you quit Chrome, the proxy drops its clients, and a reconnect doesn't bring the window back.
- New tabs open in the background. The proxy opens a new window only when none exists, and answers `Page.bringToFront` itself. Both used to raise the window on macOS, even over the pipe.
- The proxy sends `Runtime.disable` before a client's `Runtime.enable` on a shared tab, so a later session can take over a tab an earlier one left open.
- Each client's messages keep their order across the launch wait, and a malformed message no longer stops the queue.
- Chrome launches with no extensions, no startup window and no throttling of a window that sits behind other apps.
- Local tools only. Whoever connects controls a signed-in browser, so the proxy refuses any request with an `Origin` header (browsers send one, so a web page can't connect to `127.0.0.1`) and any `Host` other than `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding). Upstream accepted both. Other programs on your Mac can still connect, the same as with Chrome's own debug port.
- The setup CLI, the Claude Code plugin and skill, and tests are new.

## Limits

- macOS only.
- A copy doesn't pick up new sign-ins from your real profile. Sign in inside the agent window, or quit Chrome and run `add <profile> --recopy`.
- Each open agent window is a separate Chrome. A fresh one with one simple page uses about 500 MB. Heavy sites and long uptime add more: one with Gmail open for a day measured 1.6 GB. Quit the window to free it.
- Sync stays on in the copy for everything that `add` doesn't turn off (step 3 above), such as passwords, bookmarks, autofill and settings. A password or bookmark that an agent saves in the agent window reaches your real Google account.
- Extensions are off in the agent window, so a password manager extension doesn't fill sign-in forms there. Sign in by hand once, or let Chrome's own password manager fill them.
- Playwright's `connectOverCDP` doesn't work through the proxy. Use chrome-devtools-mcp.
- Sessions are shared by design. Two Claude sessions that enable Runtime on the same tab at the same moment can race.

## Why the proxy exists

This is a workaround for [chrome-devtools-mcp#1254](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254): on macOS, every CDP message over WebSocket activates Chrome.app and pulls focus from your terminal.

Without the proxy, `chrome-devtools-mcp` on macOS leaves two bad options:

- **`--autoConnect` to a port-mode Chrome.** Several MCP sessions can share one Chrome with your real sign-ins. But every CDP message steals focus. The WebSocket transport activates Chrome.app, and no `bringToFront: false` setting helps, because the activation happens in the transport layer.
- **Standalone, pipe transport.** No focus theft, because the pipe doesn't trigger the bug. But only the launching process can hold a pipe. Two Claude Code sessions either fight over the user-data-dir lock or each start their own throwaway Chrome, and you sign in again every session.

The proxy combines the good halves: pipe transport (no focus theft) and one long-lived daemon that owns the pipe (so many MCP sessions share one Chrome with persistent sign-ins).

## How the multiplexing works

The daemon launches Chrome with `--remote-debugging-pipe`, which gives a JSON-over-stdio CDP channel to the launching process only. It then serves a localhost HTTP and WebSocket interface in the same format as Chrome's `--remote-debugging-port` discovery (`/json/version`, `/json/list`, a browser-level WebSocket). `chrome-devtools-mcp --browserUrl http://127.0.0.1:9410` connects without knowing it isn't talking to Chrome.

Three patterns let many MCP clients share one pipe:

- **Request-ID remapping.** Each client numbers its requests `1, 2, 3, ...` on its own, and those ids would collide on the pipe. The daemon rewrites every incoming `id` to a unique proxy id, records `proxyId → {client, originalId, method}`, forwards to Chrome, and restores the original id on the response.
- **Cached target state.** The proxy turns on target discovery and auto-attach itself and caches every target and session. When a client asks for discovery or auto-attach, the proxy replays the cache to that client instead of forwarding the call.
- **Shared sessions.** Chrome's events go to every client. Clients ignore events for sessions they don't track.

About 500 lines of Node.js, one dependency (`ws`), localhost only, no telemetry.

## Running the proxy by hand

The CLI covers the usual setup. To run the proxy yourself:

```bash
npm install --omit=dev
node pipe-cdp-proxy.mjs --port 9410 \
  --user-data-dir "$HOME/Library/Application Support/Chrome-Pipe-Proxy" \
  --profile-directory Default
```

| Flag | Default | Description |
| --- | --- | --- |
| `--port` | `9410` | Port the proxy listens on for MCP clients |
| `--chrome-path` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome binary |
| `--user-data-dir` | `$HOME/Library/Application Support/Chrome-Pipe-Proxy` | Chrome data folder. Must not be Chrome's default (see below) |
| `--profile-directory` | `Default` | Profile folder inside `--user-data-dir` |

Health check:

```bash
curl -s http://127.0.0.1:9410/proxy/status
```

It returns `chromeRunning`, `chromePid`, `clients` and cache counts. Set `PROXY_DEBUG=1` to log every CDP message.

## Caveats

- **Chrome's default data folder can't be used.** Chrome refuses CDP, pipe or port, when `--user-data-dir` is `~/Library/Application Support/Google/Chrome`. The log says `DevTools remote debugging requires a non-default data directory.` This is separate from the Chrome 136+ port restriction. It's why agent-chrome copies your profile instead of using it in place.
- **All MCP clients of one proxy share one Chrome.** They see the same tabs and can step on each other if they drive the same tab.
- **No Windows or Linux support.** The pipe multiplexer would work there, but the setup CLI is macOS only and the focus bug is a macOS problem.

## Tests

```bash
npm test                          # CLI unit tests, and the proxy's local-tools-only guard
node test/live-check.mjs <port>   # drives a real Chrome through a running proxy with its window closed
```

The live check loads Puppeteer from a global `chrome-devtools-mcp` install.

## Credits

The proxy comes from [mimkorn/chrome-pipe-proxy](https://github.com/mimkorn/chrome-pipe-proxy) by Simon Democko. Its multi-client routing (request-ID remapping, session ownership) follows [henu-wang/chrome-mcp-proxy](https://github.com/henu-wang/chrome-mcp-proxy), which solves a different shape of the same problem with a WebSocket-to-WebSocket filter proxy.

## License

MIT. See [LICENSE](LICENSE).
