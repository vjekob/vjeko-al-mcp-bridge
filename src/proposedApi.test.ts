import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_ID, buildArgvContent } from './proposedApi';

test('buildArgvContent creates a fresh file when none exists', () => {
    const result = buildArgvContent(undefined);
    assert.equal(result.action, 'created');
    if (result.action !== 'created') return;
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed, { 'enable-proposed-api': [EXTENSION_ID] });
    assert.equal(result.content.endsWith('\n'), true);
});

test('buildArgvContent adds id to a plain JSON file', () => {
    const existing = JSON.stringify({ 'some-other-flag': true });
    const result = buildArgvContent(existing);
    assert.equal(result.action, 'added');
    if (result.action !== 'added') return;
    const parsed = JSON.parse(result.content);
    assert.equal(parsed['some-other-flag'], true);
    assert.deepEqual(parsed['enable-proposed-api'], [EXTENSION_ID]);
});

test('buildArgvContent appends to an existing enable-proposed-api array', () => {
    const existing = JSON.stringify({
        'enable-proposed-api': ['some.other-extension'],
    });
    const result = buildArgvContent(existing);
    assert.equal(result.action, 'added');
    if (result.action !== 'added') return;
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed['enable-proposed-api'], [
        'some.other-extension',
        EXTENSION_ID,
    ]);
});

test('buildArgvContent reports already-configured when id is already present', () => {
    const existing = JSON.stringify({
        'enable-proposed-api': ['some.other-extension', EXTENSION_ID],
    });
    const result = buildArgvContent(existing);
    assert.equal(result.action, 'already-configured');
});

test('buildArgvContent parses argv.json with line and block comments', () => {
    const existing = `// This file configures runtime args.
/* Multi
   line */
{
    // unrelated
    "some-other-flag": true
}
`;
    const result = buildArgvContent(existing);
    assert.equal(result.action, 'added');
    if (result.action !== 'added') return;
    const parsed = JSON.parse(result.content);
    assert.equal(parsed['some-other-flag'], true);
    assert.deepEqual(parsed['enable-proposed-api'], [EXTENSION_ID]);
});

test('buildArgvContent does not strip // inside string values', () => {
    const existing = JSON.stringify({ url: 'http://x/y' });
    const result = buildArgvContent(existing);
    assert.equal(result.action, 'added');
    if (result.action !== 'added') return;
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.url, 'http://x/y');
});

test('buildArgvContent reports parse-failed for unrecoverable JSON', () => {
    const result = buildArgvContent('}{ not json at all');
    assert.equal(result.action, 'parse-failed');
});

test('buildArgvContent reports parse-failed when root is an array', () => {
    const result = buildArgvContent(JSON.stringify(['a', 'b']));
    assert.equal(result.action, 'parse-failed');
});

test('buildArgvContent treats existing non-array value as missing and overwrites', () => {
    const existing = JSON.stringify({ 'enable-proposed-api': 'not an array' });
    const result = buildArgvContent(existing);
    assert.equal(result.action, 'added');
    if (result.action !== 'added') return;
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed['enable-proposed-api'], [EXTENSION_ID]);
});
