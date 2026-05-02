import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
    createBridgeServer,
    LmContentPart,
    LmHost,
    LmToolDescriptor,
} from './bridge';
import { TestRunner, TestRunSummary } from './testRunner';
import { Builder, BuildSummary } from './builder';
import { Initializer, InitializeResult } from './initializer';

interface TestOptions {
    initializer?: Initializer;
    maxAttempts?: number;
    retryDelayMs?: number;
    onTerminalFailure?: (label: string, error: unknown) => void;
}

class FakeLmHost implements LmHost {
    public readonly invocations: { name: string; input: object }[] = [];

    constructor(
        private readonly tools: readonly LmToolDescriptor[],
        private readonly responder: (
            name: string,
            input: object,
        ) => readonly LmContentPart[] = () => [{ text: 'ok' }],
    ) {}

    listTools(): readonly LmToolDescriptor[] {
        return this.tools;
    }

    async invokeTool(
        name: string,
        input: object,
    ): Promise<readonly LmContentPart[]> {
        this.invocations.push({ name, input });
        return this.responder(name, input);
    }
}

async function connectClient(
    host: LmHost,
    allowlist: ReadonlySet<string>,
    testRunner?: TestRunner,
    builder?: Builder,
    options: TestOptions = {},
): Promise<Client> {
    const server = createBridgeServer(host, {
        allowlist,
        testRunner,
        builder,
        initializer: options.initializer,
        maxAttempts: options.maxAttempts ?? 1,
        retryDelayMs: options.retryDelayMs ?? 0,
        onTerminalFailure: options.onTerminalFailure,
    });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client(
        { name: 'bridge-test', version: '0.0.0' },
        { capabilities: {} },
    );
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    return client;
}

class FakeTestRunner implements TestRunner {
    public readonly runFileCalls: { filePath: string; all: boolean | undefined }[] = [];
    public runFailedCalls = 0;

    constructor(private readonly response: TestRunSummary) {}

    async runFile(filePath: string, all?: boolean): Promise<TestRunSummary> {
        this.runFileCalls.push({ filePath, all });
        return this.response;
    }

    async runFailed(): Promise<TestRunSummary> {
        this.runFailedCalls++;
        return this.response;
    }
}

const emptyHost = new FakeLmHost([]);

class FakeBuilder implements Builder {
    public buildCalls: string[] = [];
    constructor(private readonly response: BuildSummary) {}
    async build(folderPath: string): Promise<BuildSummary> {
        this.buildCalls.push(folderPath);
        return this.response;
    }
}

class FakeInitializer implements Initializer {
    public calls: string[] = [];
    constructor(private readonly response: InitializeResult = { alExtensionActive: true }) {}
    async initialize(appJsonPath: string): Promise<InitializeResult> {
        this.calls.push(appJsonPath);
        return this.response;
    }
}

const buildSchema = {
    type: 'object' as const,
    properties: { scope: { type: 'string' } },
};

test('listTools returns only allowlisted tools', async () => {
    const host = new FakeLmHost([
        { name: 'al_build', description: 'Builds AL', inputSchema: buildSchema },
        { name: 'al_publish', description: 'Publishes', inputSchema: { type: 'object' } },
    ]);
    const client = await connectClient(host, new Set(['al_build']));

    const { tools } = await client.listTools();

    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'al_build');
    assert.equal(tools[0].description, 'Builds AL');
    assert.deepEqual(tools[0].inputSchema, buildSchema);
});

test('listTools substitutes empty schema when host has none', async () => {
    const host = new FakeLmHost([
        { name: 'al_build', description: 'd', inputSchema: undefined },
    ]);
    const client = await connectClient(host, new Set(['al_build']));

    const { tools } = await client.listTools();

    assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {} });
});

test('callTool forwards arguments and returns parts as text content', async () => {
    const host = new FakeLmHost(
        [{ name: 'al_build', description: '', inputSchema: { type: 'object' } }],
        (_name, input) => [
            { text: 'first chunk' },
            { text: `received: ${JSON.stringify(input)}` },
        ],
    );
    const client = await connectClient(host, new Set(['al_build']));

    const result = await client.callTool({
        name: 'al_build',
        arguments: { scope: 'all' },
    });

    assert.deepEqual(result.content, [
        { type: 'text', text: 'first chunk' },
        { type: 'text', text: 'received: {"scope":"all"}' },
    ]);
    assert.equal(host.invocations.length, 1);
    assert.deepEqual(host.invocations[0], {
        name: 'al_build',
        input: { scope: 'all' },
    });
});

test('callTool with empty arguments forwards an empty object', async () => {
    const host = new FakeLmHost(
        [{ name: 'al_downloadsymbols', description: '', inputSchema: { type: 'object' } }],
    );
    const client = await connectClient(host, new Set(['al_downloadsymbols']));

    await client.callTool({ name: 'al_downloadsymbols' });

    assert.deepEqual(host.invocations[0], {
        name: 'al_downloadsymbols',
        input: {},
    });
});

test('al_bridge_run_tests forwards the all flag when set to true', async () => {
    const runner = new FakeTestRunner({ passed: 30, failed: 0, failures: [] });
    const client = await connectClient(emptyHost, new Set(), runner);

    await client.callTool({
        name: 'al_bridge_run_tests',
        arguments: { filePath: 'e:\\repo\\test\\X.Test.al', all: true },
    });

    assert.deepEqual(runner.runFileCalls, [
        { filePath: 'e:\\repo\\test\\X.Test.al', all: true },
    ]);
});

test('al_bridge_run_tests rejects when all is not a boolean', async () => {
    const runner = new FakeTestRunner({ passed: 0, failed: 0, failures: [] });
    const client = await connectClient(emptyHost, new Set(), runner);

    await assert.rejects(
        client.callTool({
            name: 'al_bridge_run_tests',
            arguments: { filePath: 'x', all: 'yes' },
        }),
        /'all' must be a boolean/,
    );
});

test('callTool rejects when tool is not in allowlist', async () => {
    const host = new FakeLmHost([
        { name: 'al_publish', description: '', inputSchema: { type: 'object' } },
    ]);
    const client = await connectClient(host, new Set(['al_build']));

    await assert.rejects(
        client.callTool({ name: 'al_publish', arguments: {} }),
        /not exposed/,
    );
    assert.equal(host.invocations.length, 0);
});

test('wildcard allowlist exposes every tool the host returns', async () => {
    const host = new FakeLmHost([
        { name: 'al_build', description: '', inputSchema: { type: 'object' } },
        { name: 'runTests', description: '', inputSchema: { type: 'object' } },
        { name: 'edit_openFile', description: '', inputSchema: { type: 'object' } },
    ]);
    const client = await connectClient(host, new Set(['*']));

    const { tools } = await client.listTools();

    assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['al_build', 'edit_openFile', 'runTests'],
    );
});

test('wildcard allowlist permits invoking any tool', async () => {
    const host = new FakeLmHost(
        [{ name: 'runTests', description: '', inputSchema: { type: 'object' } }],
        () => [{ text: 'ran' }],
    );
    const client = await connectClient(host, new Set(['*']));

    const result = await client.callTool({ name: 'runTests', arguments: {} });

    assert.deepEqual(result.content, [{ type: 'text', text: 'ran' }]);
    assert.equal(host.invocations.length, 1);
});

test('host failures propagate to the MCP client as errors', async () => {
    const host: LmHost = {
        listTools: () => [
            { name: 'al_build', description: '', inputSchema: { type: 'object' } },
        ],
        invokeTool: async () => {
            throw new Error('symbol not found');
        },
    };
    const client = await connectClient(host, new Set(['al_build']));

    await assert.rejects(
        client.callTool({ name: 'al_build', arguments: {} }),
        /symbol not found/,
    );
});

test('test tools are listed only when a TestRunner is provided', async () => {
    const withRunner = await connectClient(
        emptyHost,
        new Set(),
        new FakeTestRunner({ passed: 0, failed: 0, failures: [] }),
    );
    const withoutRunner = await connectClient(emptyHost, new Set());

    const withNames = (await withRunner.listTools()).tools.map((t) => t.name).sort();
    const withoutNames = (await withoutRunner.listTools()).tools.map((t) => t.name).sort();

    assert.deepEqual(withNames, ['al_bridge_run_failed_tests', 'al_bridge_run_tests']);
    assert.deepEqual(withoutNames, []);
});

test('al_bridge_run_tests forwards filePath and returns formatted summary', async () => {
    const runner = new FakeTestRunner({
        passed: 14,
        failed: 1,
        failures: [
            {
                name: 'OnDelete_GenreHasMatchingBook',
                file: 'e:\\repo\\test\\Genre.Logic.Test.al',
                line: 47,
                message: 'Expected error did not occur',
            },
        ],
    });
    const client = await connectClient(emptyHost, new Set(), runner);

    const result = await client.callTool({
        name: 'al_bridge_run_tests',
        arguments: { filePath: 'e:\\repo\\test\\Genre.Logic.Test.al' },
    });

    assert.deepEqual(runner.runFileCalls, [
        { filePath: 'e:\\repo\\test\\Genre.Logic.Test.al', all: undefined },
    ]);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.match(text, /<summary passed=14 failed=1 \/>/);
    assert.match(text, /OnDelete_GenreHasMatchingBook/);
    assert.match(text, /Expected error did not occur/);
    assert.match(text, /line="47"/);
});

test('al_bridge_run_tests rejects when filePath is missing', async () => {
    const runner = new FakeTestRunner({ passed: 0, failed: 0, failures: [] });
    const client = await connectClient(emptyHost, new Set(), runner);

    await assert.rejects(
        client.callTool({ name: 'al_bridge_run_tests', arguments: {} }),
        /filePath/,
    );
    assert.equal(runner.runFileCalls.length, 0);
});

test('al_bridge_run_failed_tests calls runner.runFailed and returns formatted summary', async () => {
    const runner = new FakeTestRunner({ passed: 1, failed: 0, failures: [] });
    const client = await connectClient(emptyHost, new Set(), runner);

    const result = await client.callTool({
        name: 'al_bridge_run_failed_tests',
        arguments: {},
    });

    assert.equal(runner.runFailedCalls, 1);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.match(text, /<summary passed=1 failed=0 \/>/);
});

test('al_bridge_run_tests is rejected by the bridge when no TestRunner is configured', async () => {
    const client = await connectClient(emptyHost, new Set());

    await assert.rejects(
        client.callTool({ name: 'al_bridge_run_tests', arguments: { filePath: 'x' } }),
        /not exposed/,
    );
});

test('al_bridge_build tool is listed only when a Builder is provided', async () => {
    const withBuilder = await connectClient(
        emptyHost,
        new Set(),
        undefined,
        new FakeBuilder({ errors: 0, warnings: 0, infos: 0, diagnostics: [] }),
    );
    const withoutBuilder = await connectClient(emptyHost, new Set());

    const withNames = (await withBuilder.listTools()).tools.map((t) => t.name);
    const withoutNames = (await withoutBuilder.listTools()).tools.map((t) => t.name);

    assert.deepEqual(withNames, ['al_bridge_build']);
    assert.deepEqual(withoutNames, []);
});

test('al_bridge_build forwards folderPath and returns formatted summary', async () => {
    const builder = new FakeBuilder({
        errors: 1,
        warnings: 2,
        infos: 0,
        diagnostics: [
            {
                severity: 'error',
                file: 'e:\\repo\\app\\Foo.al',
                line: 12,
                column: 5,
                code: 'AL0118',
                message: 'Undefined symbol',
            },
            {
                severity: 'warning',
                file: 'e:\\repo\\app\\Bar.al',
                line: 7,
                message: 'Unused variable',
            },
        ],
    });
    const client = await connectClient(emptyHost, new Set(), undefined, builder);

    const result = await client.callTool({
        name: 'al_bridge_build',
        arguments: { folderPath: 'e:\\repo\\app' },
    });

    assert.deepEqual(builder.buildCalls, ['e:\\repo\\app']);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.match(text, /<summary errors=1 warnings=2 infos=0 \/>/);
    assert.match(text, /AL0118/);
    assert.match(text, /Undefined symbol/);
    assert.match(text, /Unused variable/);
});

test('al_bridge_build rejects when folderPath is missing', async () => {
    const builder = new FakeBuilder({ errors: 0, warnings: 0, infos: 0, diagnostics: [] });
    const client = await connectClient(emptyHost, new Set(), undefined, builder);

    await assert.rejects(
        client.callTool({ name: 'al_bridge_build', arguments: {} }),
        /folderPath/,
    );
    assert.equal(builder.buildCalls.length, 0);
});

test('al_bridge_build is rejected when no Builder is configured', async () => {
    const client = await connectClient(emptyHost, new Set());
    await assert.rejects(
        client.callTool({
            name: 'al_bridge_build',
            arguments: { folderPath: 'e:\\repo\\app' },
        }),
        /not exposed/,
    );
});

test('al_bridge_initialize is listed only when an Initializer is provided', async () => {
    const initializer = new FakeInitializer();
    const withInit = await connectClient(emptyHost, new Set(), undefined, undefined, { initializer });
    const withoutInit = await connectClient(emptyHost, new Set());

    const withNames = (await withInit.listTools()).tools.map((t) => t.name);
    const withoutNames = (await withoutInit.listTools()).tools.map((t) => t.name);

    assert.deepEqual(withNames, ['al_bridge_initialize']);
    assert.deepEqual(withoutNames, []);
});

test('al_bridge_initialize forwards appJsonPath and returns formatted result', async () => {
    const initializer = new FakeInitializer({
        alExtensionActive: true,
        message: 'all good',
    });
    const client = await connectClient(emptyHost, new Set(), undefined, undefined, { initializer });

    const result = await client.callTool({
        name: 'al_bridge_initialize',
        arguments: { appJsonPath: 'e:\\repo\\app\\app.json' },
    });

    assert.deepEqual(initializer.calls, ['e:\\repo\\app\\app.json']);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.match(text, /<init alExtensionActive="true" \/>/);
    assert.match(text, /all good/);
});

test('al_bridge_initialize rejects when appJsonPath is missing', async () => {
    const initializer = new FakeInitializer();
    const client = await connectClient(emptyHost, new Set(), undefined, undefined, { initializer });

    await assert.rejects(
        client.callTool({ name: 'al_bridge_initialize', arguments: {} }),
        /appJsonPath/,
    );
    assert.equal(initializer.calls.length, 0);
});

test('a transient tool failure is retried up to maxAttempts and ultimately succeeds', async () => {
    let attempt = 0;
    const flakyBuilder: Builder = {
        build: async () => {
            attempt++;
            if (attempt < 3) {
                throw new Error('AL not loaded yet');
            }
            return { errors: 0, warnings: 0, infos: 0, diagnostics: [] };
        },
    };
    const client = await connectClient(emptyHost, new Set(), undefined, flakyBuilder, {
        maxAttempts: 5,
        retryDelayMs: 1,
    });

    const result = await client.callTool({
        name: 'al_bridge_build',
        arguments: { folderPath: 'e:\\repo\\app' },
    });

    assert.equal(attempt, 3);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.match(text, /<summary errors=0 warnings=0 infos=0 \/>/);
});

test('a tool that always fails exhausts retries and triggers terminal failure callback', async () => {
    const alwaysFailBuilder: Builder = {
        build: async () => {
            throw new Error('command not found');
        },
    };
    const terminalCalls: { label: string; error: unknown }[] = [];
    const client = await connectClient(emptyHost, new Set(), undefined, alwaysFailBuilder, {
        maxAttempts: 3,
        retryDelayMs: 1,
        onTerminalFailure: (label, error) => terminalCalls.push({ label, error }),
    });

    await assert.rejects(
        client.callTool({
            name: 'al_bridge_build',
            arguments: { folderPath: 'e:\\repo\\app' },
        }),
        /failed after 3 attempts/,
    );

    assert.equal(terminalCalls.length, 1);
    assert.equal(terminalCalls[0].label, 'al_bridge_build');
    assert.match(String((terminalCalls[0].error as Error).message), /command not found/);
});

test('validation errors are not retried and do not trigger terminal failure', async () => {
    const builder = new FakeBuilder({ errors: 0, warnings: 0, infos: 0, diagnostics: [] });
    const terminalCalls: { label: string; error: unknown }[] = [];
    const client = await connectClient(emptyHost, new Set(), undefined, builder, {
        maxAttempts: 5,
        retryDelayMs: 1000,
        onTerminalFailure: (label, error) => terminalCalls.push({ label, error }),
    });

    const start = Date.now();
    await assert.rejects(
        client.callTool({ name: 'al_bridge_build', arguments: {} }),
        /folderPath/,
    );
    const elapsed = Date.now() - start;

    assert.equal(builder.buildCalls.length, 0);
    assert.equal(terminalCalls.length, 0);
    assert.ok(elapsed < 1000, `validation should fail fast, took ${elapsed}ms`);
});

test('a hung tool call rejects with a timeout error', async () => {
    const stalling: LmHost = {
        listTools: () => [
            { name: 'al_build', description: '', inputSchema: { type: 'object' } },
        ],
        invokeTool: () => new Promise(() => {}),
    };
    const server = createBridgeServer(stalling, {
        allowlist: new Set(['al_build']),
        requestTimeoutMs: 50,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'timeout', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await assert.rejects(
        client.callTool({ name: 'al_build', arguments: {} }),
        /timed out after 50ms/,
    );
});
