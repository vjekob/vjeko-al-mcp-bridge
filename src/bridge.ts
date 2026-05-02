import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TestRunner, formatTestRunSummary } from './testRunner';
import { Builder, formatBuildSummary } from './builder';
import { Initializer, formatInitializeResult } from './initializer';

export interface LmToolDescriptor {
    name: string;
    description: string;
    inputSchema: object | undefined;
}

export interface LmContentPart {
    text: string;
}

export interface LmHost {
    listTools(): readonly LmToolDescriptor[];
    invokeTool(name: string, input: object): Promise<readonly LmContentPart[]>;
}

export interface BridgeConfig {
    allowlist: ReadonlySet<string>;
    testRunner?: TestRunner;
    builder?: Builder;
    initializer?: Initializer;
    requestTimeoutMs?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
    onTerminalFailure?: (label: string, error: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1000;

export class BridgeTerminalError extends Error {
    public readonly cause: unknown;
    constructor(label: string, attempts: number, cause: unknown) {
        super(`Tool '${label}' failed after ${attempts} attempts: ${stringifyError(cause)}`);
        this.name = 'BridgeTerminalError';
        this.cause = cause;
    }
}

export class BridgeValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BridgeValidationError';
    }
}

const INITIALIZE = 'al_bridge_initialize';
const RUN_TESTS = 'al_bridge_run_tests';
const RUN_FAILED_TESTS = 'al_bridge_run_failed_tests';
const BUILD = 'al_bridge_build';

const INITIALIZE_TOOL: Tool = {
    name: INITIALIZE,
    description:
        'Initialize a Microsoft Dynamics 365 Business Central project for this MCP session by opening its `app.json` as the active editor. ' +
        'This triggers the loading of the AL Language extension, which is CRUCIAL for the full function of this MCP server: most other al_bridge_* tools (run_tests, run_failed_tests, build) and any allowlisted AL passthrough tools depend on the AL extension being active. ' +
        'On a fresh VS Code session the AL extension does not load until something forces activation, so calls to other tools may fail with "command not found" errors. ' +
        'Call this tool first, before any other al_bridge_* tool, with the path to an `app.json` of the project you intend to work on. ' +
        'Returns a structured result indicating whether the AL extension is active afterwards.',
    inputSchema: {
        type: 'object',
        properties: {
            appJsonPath: {
                type: 'string',
                description:
                    'Absolute path to an `app.json` file in the AL project to initialize. Opening it activates the AL extension for that project.',
            },
        },
        required: ['appJsonPath'],
    },
};

const RUN_TESTS_TOOL: Tool = {
    name: RUN_TESTS,
    description:
        'Run AL tests for a Microsoft Dynamics 365 Business Central project via the AL extension\'s VS Code Test Explorer integration. ' +
        'Use this whenever you need to execute AL test codeunits — after editing AL code, to verify a fix, in a TDD loop, or to confirm a regression. ' +
        'By default runs only the tests in the file at `filePath` (which is opened first to force the AL test controller to enumerate that project\'s tests). ' +
        'Set `all` to true to run every AL test in the workspace; `filePath` is still required, because opening it is what triggers test enumeration. ' +
        'Returns a structured summary: pass/fail counts plus per-failure name, file, line, and error message. ' +
        'Note: this tool runs tests; it does NOT compile. If you want to check whether the project compiles, use al_bridge_build.',
    inputSchema: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description:
                    'Absolute path to an AL test file (a codeunit with Subtype = Test). Required even when `all` is true — opening it is what makes the AL test controller enumerate tests for that project.',
            },
            all: {
                type: 'boolean',
                description:
                    'If true, run every AL test in the workspace instead of only the tests in `filePath`. Default false.',
            },
        },
        required: ['filePath'],
    },
};

const RUN_FAILED_TESTS_TOOL: Tool = {
    name: RUN_FAILED_TESTS,
    description:
        'Re-run only the AL tests that failed in the most recent test run, in this VS Code session. ' +
        'Use this in a fix-and-retry loop after al_bridge_run_tests reports failures: it skips tests that already passed and runs only the failing ones, so iteration is faster. ' +
        'Errors out if no prior test run exists in the current VS Code session — call al_bridge_run_tests first in that case. ' +
        'Returns the same pass/fail summary structure as al_bridge_run_tests.',
    inputSchema: { type: 'object', properties: {} },
};

const BUILD_TOOL: Tool = {
    name: BUILD,
    description:
        'Compile a single AL (Microsoft Dynamics 365 Business Central) project by pointing at its project folder. ' +
        'The tool searches that folder recursively for the first `app.json`, opens it as the active editor (so the AL extension treats that project as the build target), and runs the AL extension\'s `al.fullPackage` command (full dependency tree for the active project). ' +
        'Use this to verify whether the AL code in a specific project compiles cleanly after edits — before running tests, before publishing, or to surface compiler errors and warnings. ' +
        'Returns a structured summary: counts of errors / warnings / infos plus, for each diagnostic, severity, file path, line, column, code, and message. Hints are intentionally excluded. Diagnostics are scoped to files inside `folderPath`.',
    inputSchema: {
        type: 'object',
        properties: {
            folderPath: {
                type: 'string',
                description:
                    'Absolute path to the AL project folder (the folder that contains, directly or in a subdirectory, the `app.json` of the project to build). Required. The first `app.json` found under this folder identifies the project.',
            },
        },
        required: ['folderPath'],
    },
};

export function createBridgeServer(host: LmHost, config: BridgeConfig): Server {
    const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const server = new Server(
        { name: 'al-lm-tools-bridge', version: '0.0.1' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, (_req) =>
        withTimeout(handleList(host, config), timeoutMs, 'tools/list'),
    );

    server.setRequestHandler(CallToolRequestSchema, (req) =>
        withTimeout(
            handleCall(req.params.name, req.params.arguments ?? {}, host, config),
            timeoutMs,
            `tools/call ${req.params.name}`,
        ),
    );

    return server;
}

async function handleList(host: LmHost, config: BridgeConfig) {
    return {
        tools: [...exposedLmTools(host, config.allowlist), ...nativeTools(config)],
    };
}

async function handleCall(
    name: string,
    args: Record<string, unknown>,
    host: LmHost,
    config: BridgeConfig,
) {
    if (config.initializer && name === INITIALIZE) {
        const appJsonPath = readString(args, 'appJsonPath');
        return withRetry(async () => {
            const result = await config.initializer!.initialize(appJsonPath);
            return textResult(formatInitializeResult(result));
        }, name, config);
    }
    if (config.testRunner && name === RUN_TESTS) {
        const filePath = readString(args, 'filePath');
        const all = readOptionalBoolean(args, 'all');
        return withRetry(async () => {
            const summary = await config.testRunner!.runFile(filePath, all);
            return textResult(formatTestRunSummary(summary));
        }, name, config);
    }
    if (config.testRunner && name === RUN_FAILED_TESTS) {
        return withRetry(async () => {
            const summary = await config.testRunner!.runFailed();
            return textResult(formatTestRunSummary(summary));
        }, name, config);
    }
    if (config.builder && name === BUILD) {
        const folderPath = readString(args, 'folderPath');
        return withRetry(async () => {
            const summary = await config.builder!.build(folderPath);
            return textResult(formatBuildSummary(summary));
        }, name, config);
    }

    if (!isAllowed(name, config.allowlist)) {
        throw new BridgeValidationError(`Tool '${name}' is not exposed by this bridge`);
    }
    return withRetry(async () => {
        const parts = await host.invokeTool(name, args);
        return {
            content: parts.map((p) => ({ type: 'text' as const, text: p.text })),
        };
    }, name, config);
}

async function withRetry<T>(
    operation: () => Promise<T>,
    label: string,
    config: BridgeConfig,
): Promise<T> {
    const max = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const delayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= max; attempt++) {
        try {
            return await operation();
        } catch (err) {
            if (err instanceof BridgeValidationError) throw err;
            lastError = err;
            if (attempt < max) {
                await sleep(delayMs);
            }
        }
    }
    config.onTerminalFailure?.(label, lastError);
    throw new BridgeTerminalError(label, max, lastError);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        );
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function isAllowed(name: string, allowlist: ReadonlySet<string>): boolean {
    return allowlist.has('*') || allowlist.has(name);
}

function exposedLmTools(host: LmHost, allowlist: ReadonlySet<string>): Tool[] {
    return host
        .listTools()
        .filter((t) => isAllowed(t.name, allowlist))
        .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema as Tool['inputSchema']) ?? {
                type: 'object',
                properties: {},
            },
        }));
}

function nativeTools(config: BridgeConfig): Tool[] {
    const tools: Tool[] = [];
    if (config.initializer) {
        tools.push(INITIALIZE_TOOL);
    }
    if (config.testRunner) {
        tools.push(RUN_TESTS_TOOL, RUN_FAILED_TESTS_TOOL);
    }
    if (config.builder) {
        tools.push(BUILD_TOOL);
    }
    return tools;
}

function readString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) {
        throw new BridgeValidationError(`'${key}' is required and must be a non-empty string`);
    }
    return v;
}

function readOptionalBoolean(
    args: Record<string, unknown>,
    key: string,
): boolean | undefined {
    const v = args[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') {
        throw new BridgeValidationError(`'${key}' must be a boolean if provided`);
    }
    return v;
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
