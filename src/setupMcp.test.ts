import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLIENTS,
    ClientConfig,
    SERVER_ID,
    buildConfigContent,
    isConfigured,
} from './setupMcp';

const CLAUDE: ClientConfig = CLIENTS.find((c) => c.id === 'claude-code')!;
const CURSOR: ClientConfig = CLIENTS.find((c) => c.id === 'cursor')!;

test('isConfigured returns false for missing file', () => {
    assert.equal(isConfigured(undefined, CLAUDE), false);
});

test('isConfigured returns false for empty/invalid JSON', () => {
    assert.equal(isConfigured('', CLAUDE), false);
    assert.equal(isConfigured('not json', CLAUDE), false);
});

test('isConfigured returns false when our server id is absent', () => {
    const content = JSON.stringify({ mcpServers: { other: { url: 'http://x/' } } });
    assert.equal(isConfigured(content, CLAUDE), false);
});

test('isConfigured returns true when our server id is present (mcpServers)', () => {
    const content = JSON.stringify({
        mcpServers: { [SERVER_ID]: { url: 'http://127.0.0.1:1234/' } },
    });
    assert.equal(isConfigured(content, CLAUDE), true);
    assert.equal(isConfigured(content, CURSOR), true);
});

test('buildConfigContent creates fresh file with type=http for Claude Code', () => {
    const out = buildConfigContent(undefined, CLAUDE, 39127);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, {
        mcpServers: {
            [SERVER_ID]: { url: 'http://127.0.0.1:39127/', type: 'http' },
        },
    });
    assert.equal(out.endsWith('\n'), true);
});

test('buildConfigContent omits type for Cursor', () => {
    const out = buildConfigContent(undefined, CURSOR, 39127);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, {
        mcpServers: { [SERVER_ID]: { url: 'http://127.0.0.1:39127/' } },
    });
});

test('buildConfigContent uses the resolved port', () => {
    const out = buildConfigContent(undefined, CLAUDE, 50000);
    const parsed = JSON.parse(out);
    assert.equal(parsed.mcpServers[SERVER_ID].url, 'http://127.0.0.1:50000/');
});

test('buildConfigContent preserves other servers in existing file', () => {
    const existing = JSON.stringify({
        mcpServers: {
            'some-other-server': { command: 'node', args: ['x.js'] },
        },
    });
    const out = buildConfigContent(existing, CLAUDE, 39127);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.mcpServers['some-other-server'], {
        command: 'node',
        args: ['x.js'],
    });
    assert.deepEqual(parsed.mcpServers[SERVER_ID], {
        url: 'http://127.0.0.1:39127/',
        type: 'http',
    });
});

test('buildConfigContent overwrites a stale entry with the same id', () => {
    const existing = JSON.stringify({
        mcpServers: { [SERVER_ID]: { url: 'http://127.0.0.1:1/' } },
    });
    const out = buildConfigContent(existing, CLAUDE, 39127);
    const parsed = JSON.parse(out);
    assert.equal(parsed.mcpServers[SERVER_ID].url, 'http://127.0.0.1:39127/');
});

test('buildConfigContent recovers from invalid existing JSON by starting fresh', () => {
    const out = buildConfigContent('}{not json', CLAUDE, 39127);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, {
        mcpServers: {
            [SERVER_ID]: { url: 'http://127.0.0.1:39127/', type: 'http' },
        },
    });
});

test('buildConfigContent preserves unrelated top-level keys', () => {
    const existing = JSON.stringify({
        somethingElse: { keep: 'me' },
        mcpServers: { other: { url: 'http://o/' } },
    });
    const out = buildConfigContent(existing, CLAUDE, 39127);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.somethingElse, { keep: 'me' });
    assert.deepEqual(parsed.mcpServers.other, { url: 'http://o/' });
    assert.deepEqual(parsed.mcpServers[SERVER_ID], {
        url: 'http://127.0.0.1:39127/',
        type: 'http',
    });
});
