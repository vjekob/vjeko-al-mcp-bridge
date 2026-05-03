# AL Language MCP Bridge

A VS Code extension that runs a localhost **MCP (Model Context Protocol) server** and exposes a curated set of AL development capabilities to external MCP clients such as Claude Code, Cursor, or any other agent that speaks MCP.

When this extension is active, the running VS Code instance becomes a tool host that an outside agent can drive: run AL tests, re-run the failed ones, build the AL project, and call selected tools contributed by Microsoft's AL Language extension — all without that agent having to embed VS Code, install the AL toolchain itself, or go through Copilot Chat.

## Why this exists

The AL Language extension registers its tools through VS Code's **Language Model Tool API**, which only surfaces them inside VS Code's own chat — i.e. to GitHub Copilot. Any other coding agent (Claude Code, Cursor, anything running in a separate process) has no way to reach them. Building and running AL tests should not be Copilot-only.

The bridge fixes that by being a VS Code extension itself — same process as the AL extension, full access to `vscode.*` — that re-publishes the relevant capabilities over an MCP transport. External agents see a normal MCP server.

## What it exposes

### Bridge-native tools (always on)

These are implemented directly against VS Code APIs — no LM-tool indirection, no confirmation prompts.

| Tool | What it does |
| --- | --- |
| `al_bridge_initialize` | Takes an `appJsonPath`, opens it as the active editor, and forces the AL Language extension to activate. **Call this first.** Most other tools depend on the AL extension being loaded, and on a fresh VS Code session it is not. Returns a structured result indicating whether AL is active afterwards. |
| `al_bridge_run_tests` | Opens a test file (so the AL test runner enumerates it), then runs that file. With `all: true`, runs every test in the workspace instead. Returns a structured pass/fail summary with failure messages and source locations. |
| `al_bridge_run_failed_tests` | Re-runs only the tests that failed in the last run (`testing.reRunFailedFromLastRun`). |
| `al_bridge_build` | Takes a `folderPath`, finds the first `app.json` under that folder, opens it as the active editor (so the AL extension treats that project as the build target), and triggers `al.fullPackage`. Returns a structured summary of AL diagnostics scoped to files inside the folder. Reports `error`, `warning`, and `info` severities; hints are intentionally dropped. |

### LM passthrough tools (allowlist-gated)

The bridge also republishes selected tools from `vscode.lm.tools` over MCP. By default the allowlist is:

- `al_symbolsearch`
- `al_getdiagnostics`

`al_build` is intentionally **not** in the default allowlist — `al_bridge_build` covers builds with a richer interface (project-targeted, opens the right `app.json`, scoped diagnostics) and there's no benefit to also exposing the LM-tool passthrough version.

Configure via `vjekoAlMcpBridge.toolAllowlist`. Use `*` to expose every LM tool the host sees.

## Installation

This extension uses VS Code's **proposed `testObserver` API** to read structured pass/fail results back from the AL test runner. There is no stable equivalent today — the only way one extension can read another extension's test results is via this proposed API.

Two consequences:

1. **It is not on the VS Code Marketplace.** Marketplace policy disallows extensions that depend on proposed APIs, so the bridge is distributed as a `.vsix`.
2. **VS Code must be launched with the proposed API enabled for this specific extension.** Per-extension opt-in, via a command-line flag.

### Install the VSIX

Download `vjeko-al-mcp-bridge-<version>.vsix` and install it:

```
code --install-extension vjeko-al-mcp-bridge-<version>.vsix
```

Or in VS Code: `Extensions` view → `…` menu → **Install from VSIX…**.

### Enable the proposed API

The proposed API has to be enabled per-extension in VS Code. There are three ways to do it; pick one.

**Recommended: durable, via the bundled command.** After installing the VSIX, open the Command Palette and run **AL MCP Bridge: Enable Proposed API (durable)** (id `vjekoAlMcpBridge.enableProposedApi`). This writes the right entry into `argv.json` (`%USERPROFILE%\.vscode\argv.json` on Windows, `~/.vscode/argv.json` elsewhere; `.vscode-insiders` for Insiders) so VS Code applies the flag on every launch, no matter how it's started. Existing entries in `argv.json` are preserved. **You must fully quit and reopen VS Code afterwards — Reload Window is not enough.**

The extension also detects on activation whether the proposed API is missing and prompts you to run this command, so for most users this happens automatically.

**Alternative 1: durable, by hand.** Open `argv.json` via Command Palette → **Preferences: Configure Runtime Arguments**, and add:

```json
{
  "enable-proposed-api": ["vjeko.vjeko-al-mcp-bridge"]
}
```

Then fully quit and reopen VS Code.

**Alternative 2: per-launch.** Start VS Code with:

```
code --enable-proposed-api vjeko.vjeko-al-mcp-bridge
```

This only applies to that specific launch. Useful for one-off testing.

Without one of these in place, VS Code still loads the extension, but `vscode.tests.testResults` is unavailable and `al_bridge_run_tests` / `al_bridge_run_failed_tests` cannot return pass/fail summaries — they report that no result event arrived.

> The `vsce publish --allow-proposed-apis` flag only bypasses the **publishing-side** check. It does not unlock the API on end users' machines: stable VS Code requires `--enable-proposed-api <publisher>.<extension>` (or the equivalent `argv.json` entry) at launch regardless of how the extension was distributed. That's why publishing to the Marketplace doesn't help here even with the bypass flag.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `vjekoAlMcpBridge.port` | `39127` | Localhost TCP port the MCP server listens on. |
| `vjekoAlMcpBridge.toolAllowlist` | `["al_symbolsearch", "al_getdiagnostics"]` | LM tool ids to republish. `*` exposes all. |

## Connecting a client

The bridge listens on `http://127.0.0.1:<port>/` (Streamable HTTP transport). For each MCP client you want to drive against the bridge, you have to write a project-scoped config file telling that client about the server. The extension can do that for you — see the next section.

The bridge activates when the workspace contains an `app.json` (i.e. when it is an AL workspace), so open the AL project you want the agent to operate on in this VS Code instance, then run the registration command.

## Registering the bridge with MCP clients (the `setupMcp` command)

The extension contributes a single VS Code command:

> **AL MCP Bridge: Set Up MCP Server for Coding Agents** &nbsp;(id: `vjekoAlMcpBridge.setupMcp`)

Run it from the Command Palette (`Ctrl+Shift+P` → start typing "AL MCP Bridge"). The command writes the right project-scoped MCP config file for each client you select, so external agents — currently **Claude Code** and **Cursor** — can discover this bridge.

> VS Code itself is not a target. The bridge runs *inside* VS Code, so VS Code's own Copilot Chat / agent mode already has direct access to the AL extension's LM tools — bridging VS Code back to itself would be pointless.

### What it does, step by step

1. **Resolves the port** from `vjekoAlMcpBridge.port` via `vscode.workspace.getConfiguration(...)`, which means VS Code's normal layered resolution applies: folder settings → workspace settings → `*.code-workspace` settings → user settings → the package-declared default (`39127`). Whatever the running bridge is listening on is what gets written to each client's config.

2. **Inspects the project root** for the supported clients' config files and decides whether each is "already registered" — i.e. whether the file exists and contains an `al-mcp-bridge` entry under that client's servers map:

   | Client | Config file | Servers key |
   | --- | --- | --- |
   | Claude Code | `.mcp.json` | `mcpServers` |
   | Cursor | `.cursor/mcp.json` | `mcpServers` |

3. **Shows a multi-select QuickPick** listing **only the clients that are not yet registered**. Already-registered clients do not appear, so you can run the command repeatedly and only ever see what's left to do. If every supported client is already registered, the command shows an info message and changes nothing.

4. **For each picked client**, creates the parent directory if needed and either creates or merges into its config file. Existing servers in the file are preserved; only the `al-mcp-bridge` entry is added or updated.

5. **Reports** which files were created vs updated.

### What the command writes

Each client gets the same logical entry — an HTTP server pointed at `http://127.0.0.1:<port>/` — but the schemas differ slightly:

- **Claude Code (`.mcp.json`)** — `mcpServers` map, with `type: "http"`:

  ```json
  {
    "mcpServers": {
      "al-mcp-bridge": {
        "url": "http://127.0.0.1:39127/",
        "type": "http"
      }
    }
  }
  ```

- **Cursor (`.cursor/mcp.json`)** — `mcpServers` map, no `type` field:

  ```json
  {
    "mcpServers": {
      "al-mcp-bridge": {
        "url": "http://127.0.0.1:39127/"
      }
    }
  }
  ```

### Scope

The command is **project-scoped**. It only touches files inside the open workspace folder. It never modifies user-scope MCP config (`~\.cursor\mcp.json`, `~\.claude.json`, etc.).

### After running

Clients usually need a reload to pick up new MCP servers — restart Cursor or restart your Claude Code CLI session. Then the bridge's tools (`al_bridge_run_tests`, `al_bridge_run_failed_tests`, `al_bridge_build`, plus any allowlisted passthrough tools) are visible to the agent.

Bridge activity is written to the **AL MCP Bridge** output channel inside VS Code — open it from the Output panel if you need to see what the bridge is doing.
