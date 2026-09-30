---
name: agent-chrome
description: Use the user's signed-in Chrome from Claude Code (their real browser profiles, logged-in sites, accounts they are already signed in to) through agent-chrome, in a background window that never takes focus. Also use to set that up, add or remove a profile, or check why a chrome-<name> MCP server is not working. macOS only.
---

# agent-chrome

agent-chrome gives each chosen Chrome profile its own copy, a proxy that starts at login, and a user-scope MCP server named `chrome-<slug>`. The agent window opens in the background and stays behind the user's apps.

## Set up a profile

The CLI sits two folders above this skill:

```bash
node "${CLAUDE_SKILL_DIR}/../../bin/agent-chrome.mjs" <command>
```

If that file is missing (the skill was copied on its own), run `npx -y github:rav4nn/agent-chrome <command>` instead.

1. Run `profiles`. It lists each Chrome profile's folder, name and email, and the slug of any profile that's already set up.
2. Ask the user which profile or profiles to set up. Don't pick one yourself.
3. Tell the user to quit Chrome (Cmd+Q) first, so the copy is clean. If they won't quit it, `--force` copies anyway, but live databases may copy in a mixed state and the copy can lose sign-ins. Only pass `--force` after the user says yes to that.
4. Run `add "<profile>"`. It accepts the folder, name or email. Useful options: `--name <slug>`, `--color <#rrggbb>`, `--dry-run` to show the plan first. If `add` stops, read its message: it says what to do.
5. Tell the user to start a new Claude Code session (or resume one) so the new server loads.

Other commands:

| Command | What it does |
| --- | --- |
| `status` | Each installed slug: port, proxy up, agent window open, MCP server registered |
| `update` | Refreshes the proxy code and restarts every proxy (closes open agent windows) |
| `remove <slug>` | Stops the proxy and unregisters the server. Keeps the profile copy |
| `remove <slug> --delete-profile` | Also deletes the copy. Run it only when the user asks to delete it |

## Use a profile

- The tools are `mcp__chrome-<slug>__*` from chrome-devtools-mcp. They're deferred: load them with ToolSearch (for example `select:mcp__chrome-<slug>__new_page,mcp__chrome-<slug>__take_snapshot`) before the first call.
- Only use a profile the user named. Each one is signed in to different accounts.
- Open pages with `new_page` and `background: true`. The first new tab starts the agent window.
- Never close the agent window. Don't close its last tab and don't quit the browser. Only the user closes it. After they quit it, the tools report no pages, and the next `new_page` opens it again.
- If a site shows you signed out, ask the user to sign in inside the agent window (the one with the coloured theme), then carry on. The copy doesn't pick up new sign-ins from their real Chrome.
- Use chrome-devtools-mcp tools only. Playwright can't connect through the proxy.
- If the tools fail to connect, run `status` and report what it shows.
