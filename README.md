# AL Language MCP Bridge

A VS Code extension that runs a localhost **MCP (Model Context Protocol) server** and exposes a curated set of AL development capabilities to external MCP clients such as Claude Code, Cursor, or any other agent that speaks MCP.

When this extension is active, the running VS Code instance becomes a tool host that an outside agent can drive: run AL tests, re-run the failed ones, build the AL project, and call selected tools contributed by Microsoft's AL Language extension — all without that agent having to embed VS Code, install the AL toolchain itself, or go through Copilot Chat.

## Why this exists

VS Code's **Language Model Tool API** lets extensions register tools that LLMs can call, but in practice those tools are reachable only inside VS Code's own chat surface (Copilot Chat). An external agent that wants to use them runs into three walls:

1. **It can't reach them.** The tools live behind VS Code's chat APIs, not on a network socket. An agent running in a separate process has no way in.
2. **Confirmation prompts.** Even where invocation is technically possible (e.g. via `vscode.lm.invokeTool`), some tools surface a modal "Allow this tool to run?" prompt every call. That breaks any non-interactive workflow.
3. **Wrong abstraction for some jobs.** Running tests and building an AL project are first-class VS Code operations (testing API, `al.fullPackage` command). Routing them through the LM-tool flow adds a layer that only gets in the way.

The bridge solves all three by being a VS Code extension itself — same process as the AL extension, full access to `vscode.*` — that **re-publishes** the capabilities over an MCP transport. External agents see a normal MCP server. The bridge does the translation.

The deeper point worth keeping: it is possible to expose VS Code's APIs (testing API, command palette, language model tools, diagnostics) to outside MCP clients by hosting the MCP server *inside* a VS Code extension. This bridge is a working demonstration scoped to AL, but the pattern generalizes.

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

## How it works

- **Transport:** Streamable HTTP, **stateless**. A fresh `Server` and `StreamableHTTPServerTransport` are created per incoming POST and torn down when the response is sent. No sessions, no `Mcp-Session-Id`, no server-side state to get out of sync.
- **Timeouts:** every `tools/list` and `tools/call` is wrapped in a 5-minute timeout so a stuck VS Code command can't hang the client forever.
- **Cold-start retry (in `al_bridge_run_tests`):** when AL hasn't yet enumerated the tests in the file, `testing.run.uri` returns almost instantly with no result event. The bridge detects this (fast trigger + no event) and retries up to 5 times with a 1s backoff. The retry lives **inside the tool** so callers don't have to implement it.
- **Outer retry + terminal failure:** every tool execution is wrapped in a generic retry loop — up to 5 attempts with 1s backoff between them. Validation errors (missing/invalid arguments, "not exposed") are *not* retried; they fail fast. When all retries exhaust, the bridge throws a `BridgeTerminalError` and the HTTP layer **destroys the underlying TCP socket** so the agent gets a hard connection abort instead of a soft error response it might silently ignore. This matters when the AL extension is not yet loaded: instead of returning fake-success diagnostics or hanging, the bridge gives up loudly after ~5 seconds.
- **Logging:** activity is written to the `AL MCP Bridge` output channel inside VS Code.

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

> **AL MCP Bridge: Register MCP Bridge with Clients** &nbsp;(id: `vjekoAlMcpBridge.setupMcp`)

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

### Idempotence and merging

- Re-running the command after registering some clients only offers the rest.
- If a target file already has other MCP servers configured, those entries are preserved untouched — only the `al-mcp-bridge` key is added or updated.
- If a target file is corrupt JSON, the command starts a fresh document rather than refusing — so a malformed file does not block the workflow.

### Scope

The command is **project-scoped**. It only touches files inside the open workspace folder. It never modifies user-scope MCP config (`~\.cursor\mcp.json`, `~\.claude.json`, etc.).

### After running

Clients usually need a reload to pick up new MCP servers — restart Cursor or restart your Claude Code CLI session. Then the bridge's tools (`al_bridge_run_tests`, `al_bridge_run_failed_tests`, `al_bridge_build`, plus any allowlisted passthrough tools) are visible to the agent.

## Development

```
npm install
npm run watch    # tsc --watch
npm test         # node --test via tsx
```

Press `F5` to launch an Extension Development Host with the proposed `testObserver` API enabled (required for reading test results back from the testing API). The launch profile does not bake in a workspace path — open whichever AL workspace you want to drive.

## Layout

```
src/
  bridge.ts           MCP server factory, tool registration, timeouts.
  testRunner.ts       TestRunner interface + result formatting.
  builder.ts          Builder interface + diagnostic formatting.
  setupMcp.ts         Pure logic for the "register with MCP clients" command:
                      per-client schema, isConfigured, buildConfigContent.
  extension.ts        VS Code glue: HTTP server, LmHost / TestRunner / Builder
                      implementations, setupMcp command registration.
  bridge.test.ts      Bridge / tool tests.
  setupMcp.test.ts    Pure-logic tests for the registration command.
  vscode.proposed.testObserver.d.ts
                      Type augmentation for the proposed testing-results API.
```

`bridge.ts` knows nothing about VS Code — it depends on small interfaces (`LmHost`, `TestRunner`, `Builder`) that `extension.ts` implements. That split is what makes the tests runnable under plain `node --test`.
