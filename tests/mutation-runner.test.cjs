const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyMutation, validateManifest, classifyGo, classifyNode, summarize, cleanSandbox, parseArgs } = require('../scripts/mutation-test.cjs');

const result = overrides => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...overrides });
const events = list => list.map(event => JSON.stringify(event)).join('\n');

test('mutation anchors must match exactly once and must change source', () => {
    const mutation = { id: 'js-example', edits: [{ find: 'x > 1', replace: 'x >= 1' }] };
    assert.equal(applyMutation('if (x > 1) throw Error();', mutation), 'if (x >= 1) throw Error();');
    assert.throws(() => applyMutation('x > 2', mutation));
    assert.throws(() => applyMutation('x > 1; x > 1', mutation));
    assert.throws(() => applyMutation('x', { id: 'bad', edits: [{ find: 'x', replace: 'x' }] }));
});

test('manifest cannot mutate tests or use duplicate IDs', () => {
    const mutant = { id: 'js-example', description: 'example', file: 'static/js/serial-data.js', suite: 'frontend', edits: [{ find: 'x', replace: 'y' }] };
    const sources = new Map([[mutant.file, 'x']]);
    validateManifest({ schemaVersion: 1, mutants: [mutant] }, sources);
    assert.throws(() => validateManifest({ schemaVersion: 1, mutants: [mutant, mutant] }, sources));
    assert.throws(() => validateManifest({ schemaVersion: 1, mutants: [{ ...mutant, file: 'tests/browser.test.cjs' }] }, sources));
});

test('Go requires a failed test, not just a nonzero exit or failed package', () => {
    assert.equal(classifyGo(result({ code: 1, stdout: events([{ Action: 'fail', Package: 'x', Test: 'TestGuard' }]) })).status, 'killed');
    assert.equal(classifyGo(result({ code: 1, stdout: events([{ Action: 'fail', Package: 'x' }]) })).status, 'error');
    assert.equal(classifyGo(result({ stdout: events([{ Action: 'pass', Test: 'TestGuard' }]) })).status, 'survived');
    assert.equal(classifyGo(result()).status, 'error');
});

test('Go build failures and timeouts are never counted as kills', () => {
    assert.equal(classifyGo(result({ code: 1, stdout: events([{ Action: 'fail', FailedBuild: 'x' }]) })).status, 'invalid');
    assert.equal(classifyGo(result({ code: 1, stdout: events([{ Action: 'output', Output: 'panic: test timed out after 15s' }]) })).status, 'timeout');
    assert.equal(classifyGo(result({ code: 1, timedOut: true })).status, 'timeout');
    assert.equal(classifyGo(result({ error: 'ENOENT' })).status, 'error');
});

test('Node requires TAP test evidence and distinguishes timeouts', () => {
    assert.equal(classifyNode(result({ code: 1, stdout: 'not ok 1 - guard\n# tests 1\n# fail 1\n' })).status, 'killed');
    assert.equal(classifyNode(result({ stdout: '# tests 2\n# fail 0\n' })).status, 'survived');
    assert.equal(classifyNode(result({ stdout: '# tests 2\r\n# fail 0\r\n' })).status, 'survived');
    assert.equal(classifyNode(result({ code: 1, stderr: 'process failed' })).status, 'error');
    assert.equal(classifyNode(result({ code: 1, stdout: 'testTimeoutFailure\nnot ok 1 - guard\n# tests 1\n# fail 1\n' })).status, 'timeout');
});

test('score excludes invalid/timeout/error and the gate requires all kills', () => {
    const summary = summarize(['killed', 'survived', 'invalid', 'timeout', 'error'].map(status => ({ status })));
    assert.equal(summary.score, 0.5);
    assert.equal(summary.gatePassed, false);
    assert.equal(summarize([]).score, null);
    assert.equal(summarize([{ status: 'killed' }]).gatePassed, true);
});

test('cleanup refuses non-sandbox directories', () => {
    const protectedDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shareserial-protected-'));
    assert.throws(() => cleanSandbox(protectedDir));
    assert.equal(fs.existsSync(protectedDir), true);
    fs.rmdirSync(protectedDir); // empty, non-recursive cleanup
});

test('CLI requires explicit known options', () => {
    assert.deepEqual(parseArgs(['--only', 'go-a,js-b']).only, ['go-a', 'js-b']);
    assert.throws(() => parseArgs(['--threshold', '0']));
    assert.throws(() => parseArgs(['--go']));
    assert.equal(parseArgs(['--go', '.local/tools/go/bin/go']).go, path.resolve('.local/tools/go/bin/go'));
});
