// Contract-focused mutation testing using only Node's standard library.
// Mutants run one at a time in an allowlisted copy, never in the working tree.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = new Set(['main.go', 'ice_config.go', 'websocket/hub.go', 'websocket/access.go', 'handler/websocket.go',
    'websocket/config.go', 'websocket/replay.go', 'websocket/flash.go', 'websocket/probe.go', 'websocket/serial_p2p.go', 'static/js/serial-p2p.js', 'static/js/p2p-probe-link.js', 'static/js/serial-config.js', 'static/js/local-config.js',
    'static/js/serial-data.js', 'static/js/serial-tools.js', 'static/js/p2p-network.js', 'static/js/rx-replay.js', 'static/js/local.js', 'static/js/remote.js', 'static/js/network-reference.js',
    'static/js/esp32-manifest.js', 'static/js/esp32-flasher.js', 'static/js/remote-serial-port.js', 'handler/network.go', 'resource/limits.go']);
const COPY = ['go.mod', 'go.sum', 'main.go', 'main_test.go', 'ice_config.go', 'ice_config_test.go', 'desktop_windows.go', 'desktop_other.go', 'distribution_info.go', 'distribution_info_test.go',
    'desktop_windows_test.go', 'resource_test.go', 'multiwriter_test.go', 'LICENSE', 'VERSION', 'THIRD_PARTY_NOTICES.txt', 'docs/THIRD_PARTY_NOTICES.md',
    'handler', 'websocket', 'resource', 'localcert', 'cmd', 'static', 'tests'];
const FRONTEND_TESTS = ['tests/serial-data.test.cjs', 'tests/browser.test.cjs', 'tests/access.test.cjs',
    'tests/network-reference.test.cjs', 'tests/p2p-network.test.cjs', 'tests/esp32-manifest.test.cjs', 'tests/remote-serial-port.test.cjs', 'tests/p2p-probe.test.cjs', 'tests/serial-p2p.test.cjs', 'tests/serial-tools.test.cjs'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function applyMutation(source, mutation) {
    let result = source;
    for (const edit of mutation.edits) {
        if (!edit.find || edit.find === edit.replace) throw new Error('Empty or no-op mutation: ' + mutation.id);
        const count = result.split(edit.find).length - 1;
        if (count !== 1) throw new Error(mutation.id + ': expected exactly one anchor, found ' + count);
        result = result.replace(edit.find, () => edit.replace);
    }
    if (result === source) throw new Error('Mutation did not change source: ' + mutation.id);
    return result;
}

function validateManifest(manifest, sources) {
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.mutants) || !manifest.mutants.length) {
        throw new Error('Unsupported or empty mutation manifest');
    }
    const ids = new Set();
    for (const mutation of manifest.mutants) {
        if (!/^(go|js)-[a-z0-9-]+$/.test(mutation.id) || ids.has(mutation.id)) throw new Error('Invalid/duplicate mutation ID');
        ids.add(mutation.id);
        if (!SOURCES.has(mutation.file) || !['go-hub', 'go-server', 'frontend'].includes(mutation.suite)) {
            throw new Error('Mutation target/suite is not allowlisted: ' + mutation.id);
        }
        if (mutation.file.endsWith('.go') !== mutation.suite.startsWith('go-')) throw new Error('Language/suite mismatch');
        if (!mutation.description || !Array.isArray(mutation.edits) || !mutation.edits.length ||
            mutation.edits.some(edit => typeof edit.find !== 'string' || typeof edit.replace !== 'string')) {
            throw new Error('Invalid mutation edits: ' + mutation.id);
        }
        applyMutation(sources.get(mutation.file), mutation);
    }
}

function classifyGo(result) {
    const events = result.stdout.split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
    const output = events.map(event => event.Output || '').join('') + result.stderr;
    if (result.error) return { status: 'error', reason: result.error, tests: [] };
    if (result.timedOut || /panic: test timed out after/.test(output)) return { status: 'timeout', tests: [] };
    if (events.some(event => event.FailedBuild || event.Action === 'build-fail') || /\[build failed\]/.test(output)) {
        return { status: 'invalid', reason: 'Go build or vet failed', tests: [] };
    }
    const failed = events.filter(event => event.Action === 'fail' && event.Test).map(event => event.Package + '/' + event.Test);
    const passed = events.filter(event => event.Action === 'pass' && event.Test);
    if (result.code !== 0 && failed.length) return { status: 'killed', tests: [...new Set(failed)] };
    if (result.code === 0 && passed.length && !failed.length) return { status: 'survived', tests: [] };
    return { status: 'error', reason: 'No conclusive test result (package failure is not a kill)', tests: [] };
}

function classifyNode(result) {
    result = { ...result, stdout: result.stdout.replaceAll('\r\n', '\n') };
    if (result.error) return { status: 'error', reason: result.error, tests: [] };
    if (result.timedOut || /testTimeoutFailure/.test(result.stdout)) return { status: 'timeout', tests: [] };
    const count = Number([...result.stdout.matchAll(/^# tests (\d+)$/gm)].at(-1)?.[1] || 0);
    const failures = Number([...result.stdout.matchAll(/^# fail (\d+)$/gm)].at(-1)?.[1] || 0);
    const tests = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
    if (result.code !== 0 && count > 0 && failures > 0 && tests.length) return { status: 'killed', tests };
    if (result.code === 0 && count > 0 && failures === 0) return { status: 'survived', tests: [] };
    return { status: 'error', reason: 'No conclusive TAP result', tests: [] };
}

function summarize(results) {
    const counts = { killed: 0, survived: 0, invalid: 0, timeout: 0, error: 0 };
    for (const result of results) counts[result.status]++;
    const valid = counts.killed + counts.survived;
    return { total: results.length, ...counts, valid,
        score: valid ? counts.killed / valid : null,
        gatePassed: results.length > 0 && counts.killed === results.length };
}

function cleanSandbox(sandbox, tempRoot = os.tmpdir()) {
    // Only remove this runner's direct temporary child, after checking real paths.
    const parent = fs.realpathSync(tempRoot);
    const resolved = fs.realpathSync(sandbox);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('shareserial-mutations-')) {
        throw new Error('Refusing to remove a directory outside the mutation sandbox');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function copySandbox(root, tempRoot = os.tmpdir()) {
    const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(tempRoot), 'shareserial-mutations-'));
    const hashes = {};
    function copy(relative) {
        const source = path.join(root, relative);
        const info = fs.lstatSync(source);
        if (info.isSymbolicLink()) throw new Error('Symlinks are not allowed in mutation inputs: ' + relative);
        if (info.isDirectory()) {
            fs.mkdirSync(path.join(sandbox, relative), { recursive: true });
            for (const child of fs.readdirSync(source).sort()) copy(path.join(relative, child));
        } else if (info.isFile()) {
            const bytes = fs.readFileSync(source);
            fs.mkdirSync(path.dirname(path.join(sandbox, relative)), { recursive: true });
            fs.writeFileSync(path.join(sandbox, relative), bytes);
            hashes[relative.replaceAll(path.sep, '/')] = sha256(bytes);
        }
    }
    try { for (const relative of COPY) copy(relative); }
    catch (error) { cleanSandbox(sandbox, tempRoot); throw error; }
    return { sandbox, hashes };
}

function runProcess(command, args, cwd, timeout, control) {
    return new Promise(resolve => {
        const started = Date.now();
        let stdout = '', stderr = '', timedOut = false, launchError;
        const child = spawn(command, args, { cwd, windowsHide: true,
            detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GOTOOLCHAIN: 'local' } });
        function kill() {
            if (!child.pid) return;
            if (process.platform === 'win32') {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                killer.on('error', () => child.kill());
            } else {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
            }
        }
        control.kill = kill;
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', text => { stdout += text; });
        child.stderr.on('data', text => { stderr += text; });
        child.on('error', error => { launchError = error.message; });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            control.kill = null;
            resolve({ code, signal, stdout, stderr, timedOut, error: launchError, durationMs: Date.now() - started });
        });
    });
}

function parseArgs(argv) {
    const options = { go: process.env.MUTATION_GO || 'go', reportDir: '.local/mutation-report', only: [] };
    for (let i = 0; i < argv.length; i++) {
        const option = argv[i];
        if (option === '--help') { options.help = true; continue; }
        if (!['--go', '--report-dir', '--only'].includes(option) || !argv[i + 1]) throw new Error('Unknown/incomplete option: ' + option);
        const value = argv[++i];
        if (option === '--go') options.go = value;
        if (option === '--report-dir') options.reportDir = value;
        if (option === '--only') options.only.push(...value.split(','));
    }
    if (/[\\/]/.test(options.go)) options.go = path.resolve(options.go);
    return options;
}

function markdown(report) {
    const summary = summarize(report.results);
    const percent = summary.score === null ? 'N/A' : (summary.score * 100).toFixed(2) + '%';
    const lines = ['# Mutation test report', '', 'Contract-focused, hand-selected mutants; not exhaustive AST mutation coverage.', '',
        '- Started: ' + report.startedAt, '- Finished: ' + report.finishedAt,
        '- Scope: ' + report.selectedSize + '/' + report.catalogSize + ' catalog mutants',
        '- Source fingerprint: ' + report.sourceFingerprint,
        '- Baselines: ' + report.baselines.map(item => item.name + '=' + item.status).join(', '),
        '- Killed / survived / invalid / timeout / error: ' + [summary.killed, summary.survived, summary.invalid, summary.timeout, summary.error].join(' / '),
        '- Score: ' + percent + ' (killed / (killed + survived); invalids/timeouts/errors do not count as kills)',
        '- Complete: ' + report.complete, '- Gate passed: ' + (report.complete && summary.gatePassed), ''];
    if (report.error) lines.push('Run error: ' + report.error, '');
    lines.push('| ID | Source | Status | Failing tests |', '|---|---|---|---|');
    for (const result of report.results) {
        lines.push('| ' + result.id + ' | ' + result.file + ':' + result.line + ' | ' + result.status + ' | ' + result.tests.join(', ').replaceAll('|', '\\|') + ' |');
    }
    return lines.join('\n') + '\n';
}

async function main(argv) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log('node scripts/mutation-test.cjs [--go PATH] [--report-dir DIR] [--only ID[,ID]]');
        return 0;
    }
    const manifestText = fs.readFileSync(path.join(ROOT, 'tests/mutation/manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    const sources = new Map([...SOURCES].map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n')]));
    validateManifest(manifest, sources);
    for (const id of options.only) if (!manifest.mutants.some(item => item.id === id)) throw new Error('Unknown mutation: ' + id);
    const selected = manifest.mutants.filter(item => options.only.length === 0 || options.only.includes(item.id));
    const reportDir = path.resolve(ROOT, options.reportDir);
    // Reports are local artifacts; refuse arbitrary paths or overlapping source directories.
    const localRoot = path.join(ROOT, '.local');
    fs.mkdirSync(localRoot, { recursive: true });
    if (!reportDir.startsWith(localRoot + path.sep)) throw new Error('Report directory must be inside .local/');
    fs.mkdirSync(reportDir, { recursive: true });
    if (!fs.realpathSync(reportDir).startsWith(fs.realpathSync(localRoot) + path.sep)) throw new Error('Report directory escapes .local/');
    const { sandbox, hashes } = copySandbox(ROOT);
    const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
        tools: { node: process.version },
        runnerSha256: sha256(fs.readFileSync(__filename)),
        catalogSize: manifest.mutants.length, selectedSize: selected.length,
        manifestSha256: sha256(manifestText), sourceHashes: hashes,
        sourceFingerprint: sha256(JSON.stringify(hashes)), baselines: [], results: [], complete: false };
    const control = { aborted: false, kill: null };
    const abort = () => { control.aborted = true; control.kill?.(); };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    async function execute(name, command, args, timeout = 90000) {
        const result = await runProcess(command, args, sandbox, timeout, control);
        fs.writeFileSync(path.join(reportDir, name + '.log'), '$ ' + JSON.stringify([command, ...args]) + '\n' + result.stdout + result.stderr);
        if (control.aborted) throw new Error('Interrupted');
        return result;
    }
    const goArgs = target => ['test', '-json', '-count=1', '-timeout=15s', target];
    const nodeArgs = ['--test', '--test-reporter=tap', '--test-timeout=15000', ...FRONTEND_TESTS];
    try {
        const version = await execute('go-version', options.go, ['version']);
        if (version.code !== 0 || version.error || version.timedOut) throw new Error('Go toolchain is unavailable');
        report.tools.go = version.stdout.trim();
        for (const [name, command, args] of [
            ['baseline-go', options.go, goArgs('./...')],
            ['baseline-frontend', process.execPath, nodeArgs]
        ]) {
            const result = await execute(name, command, args, 300000);
            const verdict = name === 'baseline-go' ? classifyGo(result) : classifyNode(result);
            report.baselines.push({ name, status: verdict.status === 'survived' ? 'passed' : 'failed', durationMs: result.durationMs });
            if (verdict.status !== 'survived') throw new Error(name + ' failed (' + verdict.status + '); no mutation score is valid');
            console.log(name + ': PASS');
        }
        for (const mutation of selected) {
            if (control.aborted) throw new Error('Interrupted');
            const target = path.join(sandbox, mutation.file);
            const original = fs.readFileSync(target);
            const source = sources.get(mutation.file);
            const line = source.slice(0, source.indexOf(mutation.edits[0].find)).split('\n').length;
            let verdict, result;
            try {
                fs.writeFileSync(target, applyMutation(source, mutation));
                if (mutation.suite === 'frontend') {
                    const syntax = await execute(mutation.id + '-syntax', process.execPath, ['--check', mutation.file]);
                    if (syntax.error || syntax.timedOut) verdict = { status: syntax.timedOut ? 'timeout' : 'error', reason: syntax.error, tests: [] };
                    else if (syntax.code !== 0) verdict = { status: 'invalid', reason: 'JavaScript syntax error', tests: [] };
                    if (!verdict) {
                        result = await execute(mutation.id, process.execPath, nodeArgs);
                        verdict = classifyNode(result);
                    }
                } else {
                    result = await execute(mutation.id, options.go, goArgs(mutation.suite === 'go-hub' ? './websocket' : './...'));
                    verdict = classifyGo(result);
                }
            } finally {
                fs.writeFileSync(target, original);
            }
            report.results.push({ id: mutation.id, file: mutation.file, line,
                description: mutation.description, ...verdict, durationMs: result?.durationMs || 0 });
            console.log('[' + report.results.length + '/' + selected.length + '] ' + mutation.id + ': ' + verdict.status.toUpperCase());
        }
        for (const [relative, hash] of Object.entries(hashes)) {
            if (sha256(fs.readFileSync(path.join(ROOT, relative))) !== hash) throw new Error('Input changed during run: ' + relative);
        }
        report.complete = true;
    } catch (error) {
        report.error = error.message;
        console.error(error.message);
    } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        try { cleanSandbox(sandbox); }
        catch (error) { report.complete = false; report.error = (report.error || '') + '; cleanup: ' + error.message; }
        report.finishedAt = new Date().toISOString();
        report.summary = summarize(report.results);
        report.gatePassed = report.complete && report.summary.gatePassed;
        fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        fs.writeFileSync(path.join(reportDir, 'report.md'), markdown(report));
    }
    console.log(JSON.stringify(report.summary));
    console.log('Report: ' + path.relative(ROOT, path.join(reportDir, 'report.md')));
    return control.aborted ? 130 : report.complete && report.summary.gatePassed ? 0 : 1;
}

module.exports = { applyMutation, validateManifest, classifyGo, classifyNode, summarize, cleanSandbox, copySandbox, parseArgs, markdown };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
