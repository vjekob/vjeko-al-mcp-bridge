import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBridgeServer, LmHost, LmToolDescriptor } from './bridge';
import { TestFailure, TestRunSummary, TestRunner } from './testRunner';
import { BuildDiagnostic, BuildSeverity, BuildSummary, Builder } from './builder';
import { Initializer, InitializeResult } from './initializer';
import { CLIENTS, ClientConfig, buildConfigContent, isConfigured } from './setupMcp';
import { EXTENSION_ID, buildArgvContent } from './proposedApi';

let httpServer: http.Server | undefined;
let outputChannel: vscode.OutputChannel | undefined;

function log(...args: unknown[]): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    console.log('[al-mcp-bridge]', line);
    outputChannel?.appendLine(line);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('AL MCP Bridge');
    context.subscriptions.push(outputChannel);
    log('activate');

    const cfg = vscode.workspace.getConfiguration('vjekoAlMcpBridge');
    const port = cfg.get<number>('port', 39127);
    const allowlist = new Set(cfg.get<string[]>('toolAllowlist', []));
    log('config', { port, allowlist: [...allowlist] });

    const host: LmHost = {
        listTools: () =>
            vscode.lm.tools.map(
                (t): LmToolDescriptor => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                }),
            ),
        invokeTool: async (name, input) => {
            const result = await vscode.lm.invokeTool(name, {
                input,
                toolInvocationToken: undefined,
            });
            return result.content.map((part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    return { text: part.value };
                }
                return { text: JSON.stringify(part) };
            });
        },
    };

    const testRunner: TestRunner = {
        runFile: async (filePath, all) => {
            log('runFile START', { filePath, all: all === true });
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
            log('runFile file opened', { fileName: doc.fileName });

            for (let attempt = 1; attempt <= MAX_RUN_ATTEMPTS; attempt++) {
                log(`runFile attempt ${attempt}/${MAX_RUN_ATTEMPTS}`);
                const outcome = await attemptRun(async () => {
                    if (all === true) {
                        await vscode.commands.executeCommand('testing.runAll');
                        return;
                    }
                    try {
                        await vscode.commands.executeCommand('testing.run.uri', uri);
                    } catch (err) {
                        log('runFile testing.run.uri THREW; falling back to testing.runAll', String(err));
                        await vscode.commands.executeCommand('testing.runAll');
                    }
                });
                if (outcome !== 'no-op') {
                    log('runFile DONE', { attempt, passed: outcome.passed, failed: outcome.failed });
                    return outcome;
                }
                if (attempt < MAX_RUN_ATTEMPTS) {
                    log(`runFile attempt ${attempt} no-op, sleeping ${RETRY_DELAY_MS}ms`);
                    await sleep(RETRY_DELAY_MS);
                }
            }
            throw new Error(
                `No test run was dispatched after ${MAX_RUN_ATTEMPTS} attempts. The test controller may not have enumerated tests for the supplied file, or the file contains no tests.`,
            );
        },
        runFailed: async () => {
            log('runFailed START');
            const outcome = await attemptRun(() =>
                vscode.commands.executeCommand('testing.reRunFailedFromLastRun'),
            );
            if (outcome === 'no-op') {
                throw new Error(
                    'No re-run was dispatched. There may be no failed tests from a previous run, or no run has been initiated.',
                );
            }
            log('runFailed DONE', { passed: outcome.passed, failed: outcome.failed });
            return outcome;
        },
    };

    const initializer: Initializer = {
        initialize: async (appJsonPath: string): Promise<InitializeResult> => {
            log('initialize START', { appJsonPath });
            const uri = vscode.Uri.file(appJsonPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
            log('initialize: app.json opened as active editor');

            const alExt = vscode.extensions.getExtension('ms-dynamics-smb.al');
            if (alExt === undefined) {
                log('initialize: AL extension is not installed');
                return {
                    alExtensionActive: false,
                    message: 'AL extension (ms-dynamics-smb.al) is not installed in this VS Code instance.',
                };
            }
            if (!alExt.isActive) {
                log('initialize: AL extension not yet active, awaiting activate()');
                try {
                    await alExt.activate();
                    log('initialize: AL extension activate() RESOLVED');
                } catch (err) {
                    log('initialize: AL extension activate() THREW', String(err));
                    return {
                        alExtensionActive: false,
                        message: `AL extension activate() failed: ${String(err)}`,
                    };
                }
            }
            return {
                alExtensionActive: alExt.isActive,
                message: alExt.isActive
                    ? undefined
                    : 'AL extension activate() resolved but isActive is still false.',
            };
        },
    };

    const builder: Builder = {
        build: async (folderPath: string) => {
            log('build START', { folderPath });
            const appJsonUri = await findFirstAppJson(folderPath);
            log('build app.json found', { fsPath: appJsonUri.fsPath });
            const doc = await vscode.workspace.openTextDocument(appJsonUri);
            await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
            log('build app.json opened as active editor');
            await vscode.commands.executeCommand('al.fullPackage');
            log('build al.fullPackage RESOLVED');
            return collectAlBuildSummary(folderPath);
        },
    };

    httpServer = http.createServer(async (req, res) => {
        if (req.method !== 'POST') {
            respondJsonError(res, 405, -32600, 'Only POST is supported');
            return;
        }
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        const onTerminalFailure = (label: string, err: unknown): void => {
            log('TERMINAL FAILURE — destroying socket', { label, err: String(err) });
            setImmediate(() => {
                try {
                    req.socket?.destroy();
                } catch {
                    /* socket may already be gone */
                }
            });
        };
        const server = createBridgeServer(host, {
            allowlist,
            testRunner,
            builder,
            initializer,
            onTerminalFailure,
        });
        try {
            await server.connect(transport);
            const body = await readJsonBody(req);
            await transport.handleRequest(req, res, body);
        } catch (err) {
            log('http handler error', String(err));
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
        } finally {
            void transport.close();
            void server.close();
        }
    });
    httpServer.listen(port, '127.0.0.1', () => {
        log(`listening on http://127.0.0.1:${port}/mcp (stateless)`);
    });

    context.subscriptions.push({
        dispose: () => {
            httpServer?.close();
            httpServer = undefined;
        },
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('vjekoAlMcpBridge.setupMcp', () => runSetupMcp()),
        vscode.commands.registerCommand('vjekoAlMcpBridge.enableProposedApi', () =>
            runEnableProposedApi(),
        ),
    );

    void promptForProposedApiIfMissing();
}

interface ClientState {
    readonly client: ClientConfig;
    readonly fileUri: vscode.Uri;
    readonly content: string | undefined;
    readonly configured: boolean;
}

async function runSetupMcp(): Promise<void> {
    const root = pickWorkspaceRoot();
    if (root === undefined) {
        await vscode.window.showErrorMessage(
            'AL MCP Bridge: open a workspace folder before registering MCP clients.',
        );
        return;
    }

    const port = vscode.workspace.getConfiguration('vjekoAlMcpBridge').get<number>('port', 39127);

    const states = await Promise.all(
        CLIENTS.map((client) => readClientState(root, client)),
    );
    const offered = states.filter((s) => !s.configured);

    if (offered.length === 0) {
        await vscode.window.showInformationMessage(
            'AL MCP Bridge: every supported client is already registered for this project.',
        );
        return;
    }

    interface ClientPick extends vscode.QuickPickItem {
        state: ClientState;
    }
    const items: ClientPick[] = offered.map((s) => ({
        label: s.client.label,
        description: s.client.relativePath,
        picked: true,
        state: s,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'AL MCP Bridge — register with which clients?',
        placeHolder: 'Already-configured clients are not shown',
    });
    if (!picked || picked.length === 0) return;

    const reports: string[] = [];
    for (const item of picked) {
        const s = item.state;
        const newContent = buildConfigContent(s.content, s.client, port);
        const dirUri = vscode.Uri.joinPath(s.fileUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            /* createDirectory is idempotent for missing-parent only on some FS — ignore */
        }
        await vscode.workspace.fs.writeFile(s.fileUri, Buffer.from(newContent, 'utf-8'));
        reports.push(`${s.content === undefined ? 'created' : 'updated'} ${s.client.relativePath}`);
        log('setupMcp', { client: s.client.id, action: s.content === undefined ? 'created' : 'updated' });
    }
    await vscode.window.showInformationMessage(`AL MCP Bridge: ${reports.join('; ')}.`);
}

function getArgvJsonPath(): string {
    const isInsiders = vscode.env.appName.toLowerCase().includes('insiders');
    return path.join(os.homedir(), isInsiders ? '.vscode-insiders' : '.vscode', 'argv.json');
}

function isProposedApiAvailable(): boolean {
    return typeof (vscode.tests as { testResults?: unknown }).testResults !== 'undefined';
}

async function promptForProposedApiIfMissing(): Promise<void> {
    if (isProposedApiAvailable()) return;
    log('proposed API not enabled at runtime — prompting user');
    const choice = await vscode.window.showWarningMessage(
        'AL MCP Bridge: the proposed `testObserver` API is not enabled, so test result reading is disabled. Configure it now? VS Code must be fully restarted afterwards.',
        'Configure',
        'Not now',
    );
    if (choice === 'Configure') {
        await runEnableProposedApi();
    }
}

async function runEnableProposedApi(): Promise<void> {
    const argvPath = getArgvJsonPath();
    log('enableProposedApi START', { argvPath });

    let existing: string | undefined;
    try {
        existing = await fs.readFile(argvPath, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log('enableProposedApi: read failed', String(err));
            await vscode.window.showErrorMessage(
                `AL MCP Bridge: failed to read ${argvPath}: ${String(err)}`,
            );
            return;
        }
        existing = undefined;
    }

    const result = buildArgvContent(existing);

    if (result.action === 'parse-failed') {
        log('enableProposedApi: argv.json could not be parsed');
        const choice = await vscode.window.showErrorMessage(
            `AL MCP Bridge: ${argvPath} is not valid JSON. Open it manually and add "${EXTENSION_ID}" to the "enable-proposed-api" array, then restart VS Code.`,
            'Open File',
        );
        if (choice === 'Open File') {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(argvPath));
            await vscode.window.showTextDocument(doc);
        }
        return;
    }

    if (result.action === 'already-configured') {
        log('enableProposedApi: already configured');
        await vscode.window.showInformationMessage(
            `AL MCP Bridge: ${EXTENSION_ID} is already listed in ${argvPath}. If the bridge still cannot read test results, fully quit VS Code (not just Reload Window) and reopen.`,
        );
        return;
    }

    try {
        await fs.mkdir(path.dirname(argvPath), { recursive: true });
        await fs.writeFile(argvPath, result.content, 'utf-8');
    } catch (err) {
        log('enableProposedApi: write failed', String(err));
        await vscode.window.showErrorMessage(
            `AL MCP Bridge: failed to write ${argvPath}: ${String(err)}`,
        );
        return;
    }

    log('enableProposedApi DONE', { action: result.action });
    await vscode.window.showInformationMessage(
        `AL MCP Bridge: proposed API enabled in ${argvPath}. Fully quit and reopen VS Code (not just Reload Window) for the change to take effect.`,
    );
}

function pickWorkspaceRoot(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return folders[0].uri;
}

async function readClientState(
    root: vscode.Uri,
    client: ClientConfig,
): Promise<ClientState> {
    const fileUri = vscode.Uri.joinPath(root, ...client.relativePath.split('/'));
    let content: string | undefined;
    try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        content = Buffer.from(bytes).toString('utf-8');
    } catch {
        content = undefined;
    }
    return { client, fileUri, content, configured: isConfigured(content, client) };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    return text.length > 0 ? JSON.parse(text) : undefined;
}

function respondJsonError(
    res: http.ServerResponse,
    status: number,
    code: number,
    message: string,
): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
        JSON.stringify({
            jsonrpc: '2.0',
            error: { code, message },
            id: null,
        }),
    );
}

export function deactivate(): void {
    httpServer?.close();
    httpServer = undefined;
}

const FAST_TRIGGER_THRESHOLD_MS = 500;
const RESULT_WAIT_MS = 60_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RUN_ATTEMPTS = 5;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

async function attemptRun(
    trigger: () => Thenable<unknown>,
): Promise<TestRunSummary | 'no-op'> {
    const before = vscode.tests.testResults.length;
    log('attemptRun: testResults.length BEFORE =', before);
    let firedAndResolved = false;

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    const sub = vscode.tests.onDidChangeTestResults(() => {
        const now = vscode.tests.testResults.length;
        log('attemptRun: onDidChangeTestResults fire', { length: now });
        if (now > before) {
            firedAndResolved = true;
            sub.dispose();
            resolveDone();
        }
    });

    log('attemptRun: invoking trigger');
    const start = Date.now();
    await trigger();
    const elapsed = Date.now() - start;
    log('attemptRun: trigger RESOLVED', { elapsedMs: elapsed });

    if (elapsed < FAST_TRIGGER_THRESHOLD_MS && !firedAndResolved) {
        log('attemptRun: fast trigger + no event = silent no-op');
        sub.dispose();
        return 'no-op';
    }

    const timer = setTimeout(() => {
        if (!firedAndResolved) {
            log('attemptRun: result wait timed out');
            sub.dispose();
            resolveDone();
        }
    }, RESULT_WAIT_MS);
    try {
        await done;
    } finally {
        clearTimeout(timer);
    }

    if (!firedAndResolved) {
        return 'no-op';
    }
    log('attemptRun: success');
    return summarize(vscode.tests.testResults[0]);
}

function summarize(result: vscode.TestRunResult): TestRunSummary {
    log('summarize: completedAt', result?.completedAt, 'topLevelResults', result?.results?.length);
    let passed = 0;
    let failed = 0;
    const failures: TestFailure[] = [];
    walk(result.results, (snap) => {
        for (const task of snap.taskStates) {
            switch (task.state) {
                case vscode.TestResultState.Passed:
                    passed++;
                    break;
                case vscode.TestResultState.Failed:
                case vscode.TestResultState.Errored: {
                    failed++;
                    const raw = task.messages[0]?.message ?? '';
                    failures.push({
                        name: snap.id,
                        file: snap.uri?.fsPath,
                        line: snap.range?.start.line,
                        message: typeof raw === 'string' ? raw : raw.value,
                    });
                    break;
                }
                default:
                    break;
            }
        }
    });
    return { passed, failed, failures };
}

function walk(
    snaps: readonly vscode.TestResultSnapshot[],
    visit: (s: vscode.TestResultSnapshot) => void,
): void {
    for (const s of snaps) {
        if (s.taskStates.length > 0) visit(s);
        if (s.children.length > 0) walk(s.children, visit);
    }
}

async function findFirstAppJson(folderPath: string): Promise<vscode.Uri> {
    const folderUri = vscode.Uri.file(folderPath);
    const pattern = new vscode.RelativePattern(folderUri, '**/app.json');
    const matches = await vscode.workspace.findFiles(pattern);
    if (matches.length === 0) {
        throw new Error(`No app.json found under '${folderPath}'.`);
    }
    matches.sort((a, b) => a.fsPath.length - b.fsPath.length);
    return matches[0];
}

function collectAlBuildSummary(folderPath: string): BuildSummary {
    const all = vscode.languages.getDiagnostics();
    const diagnostics: BuildDiagnostic[] = [];
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const [uri, diags] of all) {
        if (!isInsideFolder(uri.fsPath, folderPath)) continue;
        for (const d of diags) {
            if (d.source !== 'AL') continue;
            const severity = mapBuildSeverity(d.severity);
            if (severity === undefined) continue;
            switch (severity) {
                case 'error': errors++; break;
                case 'warning': warnings++; break;
                case 'info': infos++; break;
            }
            diagnostics.push({
                severity,
                file: uri.fsPath,
                line: d.range.start.line + 1,
                column: d.range.start.character + 1,
                code: typeof d.code === 'string'
                    ? d.code
                    : typeof d.code === 'number'
                        ? String(d.code)
                        : (d.code as { value?: string | number } | undefined)?.value !== undefined
                            ? String((d.code as { value: string | number }).value)
                            : undefined,
                message: d.message,
            });
        }
    }
    return { errors, warnings, infos, diagnostics };
}

function isInsideFolder(filePath: string, folderPath: string): boolean {
    const normalizedFile = path.normalize(filePath).toLowerCase();
    const normalizedFolder = path.normalize(folderPath).toLowerCase();
    return (
        normalizedFile === normalizedFolder ||
        normalizedFile.startsWith(normalizedFolder + path.sep)
    );
}

function mapBuildSeverity(
    s: vscode.DiagnosticSeverity,
): BuildSeverity | undefined {
    switch (s) {
        case vscode.DiagnosticSeverity.Error:
            return 'error';
        case vscode.DiagnosticSeverity.Warning:
            return 'warning';
        case vscode.DiagnosticSeverity.Information:
            return 'info';
        default:
            return undefined;
    }
}
