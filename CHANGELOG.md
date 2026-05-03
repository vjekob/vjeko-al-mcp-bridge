# Changelog

All notable changes to the **AL Language MCP Bridge** extension are documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html): version numbers take the form **MAJOR.MINOR.PATCH**, where

- **MAJOR** increments on incompatible changes to the MCP tool surface, the configuration schema, or the public extension contracts,
- **MINOR** increments when capabilities are added in a backwards-compatible way (new tools, new settings, new commands), and
- **PATCH** increments for backwards-compatible bug fixes and internal-only changes.

Pre-1.0.0 releases (the `0.x.y` line) are considered initial development; the API may evolve between minor versions.

## [0.0.1] — 2026-05-02

Initial release of the MCP bridge.

### Added

- VS Code extension that runs a localhost **MCP (Model Context Protocol) server** over the Streamable HTTP transport, in stateless mode (a fresh server and transport are created per HTTP POST).
- **Bridge-native tools** implemented directly against VS Code APIs (no Language Model Tool indirection, no confirmation prompts):
  - `al_bridge_initialize` — opens an `app.json` as the active editor and forces the AL Language extension to activate. Required as the first call in a session.
  - `al_bridge_run_tests` — runs AL tests for a given test file (or the whole workspace with `all: true`), with built-in cold-start retry that detects silent no-ops from the AL test controller.
  - `al_bridge_run_failed_tests` — re-runs only the tests that failed in the most recent run.
  - `al_bridge_build` — takes a project folder, finds the first `app.json` under it, opens it as the active editor, and triggers `al.fullPackage`. Returns a structured diagnostic summary scoped to the project folder; hints are excluded.
- **Allowlist-gated LM tool passthrough** — the bridge republishes selected tools from `vscode.lm.tools`. Default allowlist: `al_symbolsearch`, `al_getdiagnostics`. `al_build` is intentionally excluded because `al_bridge_build` covers builds with a richer interface. `*` wildcard is supported.
- **Generic retry-and-fail-hard policy** for every tool execution: up to 5 attempts with 1s backoff. Validation errors (missing/invalid arguments, "not exposed") fail fast and are not retried. After retries exhaust, the bridge throws a `BridgeTerminalError` and destroys the underlying TCP socket so MCP clients see a hard connection abort instead of a soft error they might ignore.
- **Per-request timeout** of 5 minutes wrapping every `tools/list` and `tools/call` invocation.
- **VS Code command** `vjekoAlMcpBridge.setupMcp` (Command Palette: "AL MCP Bridge: Set Up MCP Server for Coding Agents") that creates or merges project-scoped MCP config files for **Claude Code** (`.mcp.json`) and **Cursor** (`.cursor/mcp.json`), and presents only the clients that are not yet registered. VS Code itself is not a target — bridging it back to itself would be pointless. Resolves the port through VS Code's standard layered settings (folder → workspace → workspace file → user → default).
- **Configuration:**
  - `vjekoAlMcpBridge.port` (default: `39127`) — TCP port for the MCP server.
  - `vjekoAlMcpBridge.toolAllowlist` (default: `["al_symbolsearch", "al_getdiagnostics"]`) — LM tool ids to republish.
- Output channel `AL MCP Bridge` for activity logging.
- Unit tests under `node --test` via `tsx`, covering the MCP server, the registration command's pure logic, retry behavior, terminal failure callbacks, and validation error fast-fail.
