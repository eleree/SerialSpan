// Exercise the extracted product, never go run or source-tree assets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let archive = process.argv[2];
if (!archive) throw new Error('Usage: node scripts/smoke-release.cjs <native archive or directory>');
if (fs.statSync(archive).isDirectory()) {
    const archives = fs.readdirSync(archive).filter(name => /\.(zip|tar\.gz|exe)$/.test(name));
    assert.equal(archives.length, 1, 'native smoke directory must contain one archive');
    archive = path.join(archive, archives[0]);
}
if (/\.exe$/i.test(archive)) {
    const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'smoke-standalone.cjs'), path.resolve(archive), '--file-version'], {stdio:'inherit'});
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
}
const windows = process.platform === 'win32';
const system = process.env.SystemRoot || 'C:\\Windows';
const powershell = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const runtimeEnv = { ...process.env, PATH: windows ? [path.join(system, 'System32'), system].join(';') : '/usr/bin:/bin' };
delete runtimeEnv.GOROOT;
delete runtimeEnv.NODE_PATH;
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shareserial-package-smoke-'));
const extracted = path.join(temporary, '交付 空格 & portable');
fs.mkdirSync(extracted);
let child, busyPort;
let output = '';

function launch(command, args, cwd) {
    const process = spawn(command, args, { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    process.stdout.on('data', data => { output = (output + data).slice(-16384); });
    process.stderr.on('data', data => { output = (output + data).slice(-16384); });
    return process;
}

async function stopChild() {
    if (!child || child.exitCode !== null) { child = null; return; }
    const process = child;
    const ended = new Promise(resolve => process.once('exit', resolve));
    // Kill just the launcher: its Job Object must stop the hidden server.
    if (windows) await execute(path.join(system, 'System32/taskkill.exe'), ['/PID', String(process.pid), '/F'], { windowsHide: true }).catch(() => {});
    else process.kill('SIGTERM');
    await Promise.race([ended, delay(5000).then(() => { throw new Error('packaged process did not stop'); })]);
    child = null;
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function request(port, ca, pathname) {
    return new Promise((resolve, reject) => {
        const request = https.get({ host: '127.0.0.1', port, path: pathname, ca, rejectUnauthorized: true, timeout: 1500, agent: false }, response => {
            const chunks = [];
            response.on('data', data => chunks.push(data));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }));
        });
        request.on('timeout', () => request.destroy(new Error('HTTPS timeout')));
        request.on('error', reject);
    });
}

(async () => {
    if (windows) {
        await execute(powershell, ['-NoLogo', '-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:SS_ARCHIVE -DestinationPath $env:SS_DEST'],
            { env: { ...runtimeEnv, SS_ARCHIVE: path.resolve(archive), SS_DEST: extracted }, windowsHide: true, timeout: 30000 });
    } else await execute('/usr/bin/tar', ['-xzf', path.resolve(archive), '-C', extracted]);
    const children = fs.readdirSync(extracted);
    assert.equal(children.length, 1);
    const root = path.join(extracted, children[0]);
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'BUILD.json'), 'utf8'));
    assert.equal(metadata.target, (windows ? 'windows' : process.platform) + '/' + (process.arch === 'x64' ? 'amd64' : process.arch));
    const files = fs.readdirSync(root, { recursive: true });
    assert(!files.some(file => /(^|[/\\])\.local([/\\]|$)|\.(pem|key|log)$/i.test(file)), 'package leaked private runtime files');
    assert(files.some(file => file.includes('LICENSE-Go.txt')));
    assert(fs.existsSync(path.join(root, 'licenses/esptool-js-0.7.0.LICENSE.txt')));
    const port = await freePort();
    let certificate, key;
    let launcherArgs;
    const manage = path.join(root, 'tools/manage.ps1');
    if (windows) {
        assert(fs.readFileSync(manage).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
        await execute(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', manage,
            '-Mode', 'Configure', '-HostName', '127.0.0.1', '-Port', String(port), '-NoTrust', '-NoFirewall', '-NonInteractive'],
            { cwd: root, env: runtimeEnv, windowsHide: true, timeout: 30000 });
        const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
        certificate = path.join(root, config.certificate);
        key = path.join(root, config.privateKey);
        const raw = new crypto.X509Certificate(fs.readFileSync(certificate));
        assert.equal(raw.ca, false, 'a LAN package must not create a CA');
        assert.equal(crypto.createHash('sha256').update(raw.raw).digest('hex'), config.certificateSHA256);
        assert.deepEqual(fs.readFileSync(path.join(root, 'ShareSerial-LAN.cer')), raw.raw);
        launcherArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', manage, '-Mode', 'Start', '-NoBrowser', '-NoTrust', '-NonInteractive'];
        child = launch(powershell, launcherArgs, root);
    } else {
        certificate = path.join(root, 'certs/cert.pem');
        key = path.join(root, 'certs/key.pem');
        await execute(path.join(root, 'tools/shareserial-cert'), ['-out', path.dirname(certificate), '-hosts', 'localhost,127.0.0.1', '-days', '365', '-name', 'ShareSerial LAN'], { cwd: root, env: runtimeEnv });
        runtimeEnv.SHARESERIAL_ADDR = '127.0.0.1:' + port;
        runtimeEnv.SHARESERIAL_CERT = certificate;
        runtimeEnv.SHARESERIAL_KEY = key;
        child = launch('/bin/sh', ['./start.sh'], root);
    }
    const ca = fs.readFileSync(certificate);
    let response;
    for (let i = 0; i < 150; i++) {
        assert.equal(child.exitCode, null, 'launcher exited before readiness: ' + output);
        try { response = await request(port, ca, '/api/network-sample'); if (response.status === 204) break; } catch {}
        await delay(200);
    }
    assert.equal(response?.status, 204, 'packaged HTTPS server never became ready: ' + output);
    for (const page of ['/local', '/remote', '/remote/esp32', '/static/js/i18n.js', '/static/js/esp32-flasher.js', '/static/vendor/esptool-js-0.7.0.js']) {
        const response = await request(port, ca, page);
        assert.equal(response.status, 200, page);
        assert(response.body.length > 0, page);
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(certificate)).digest('hex');
    await stopChild();
    await assert.rejects(request(port, ca, '/api/network-sample'), 'closing the launcher must stop its own server');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(certificate)).digest('hex'), sha, 'starting must preserve the server certificate');
    assert(fs.existsSync(key));
    if (windows) {
        // Exercise the actual double-click wrapper as well as the managed
        // PowerShell entry point. The package path contains spaces and '&'.
        child = launch(path.join(system, 'System32/cmd.exe'), ['/d', '/c', 'Start.cmd -NoBrowser -NoTrust -NonInteractive'], root);
        let wrapperReady = false;
        for (let i = 0; i < 100; i++) {
            assert.equal(child.exitCode, null, 'Start.cmd exited early: ' + output);
            try { wrapperReady = (await request(port, ca, '/api/network-sample')).status === 204; } catch {}
            if (wrapperReady) break;
            await delay(200);
        }
        assert(wrapperReady, 'Start.cmd did not launch the packaged server');
        const managed = await execute(powershell, ['-NoLogo', '-NoProfile', '-Command',
            'Get-CimInstance Win32_Process -Filter (\'ParentProcessId = \' + $env:SS_CMD_PID) | Where-Object { $_.Name -eq \'powershell.exe\' } | Select-Object -ExpandProperty ProcessId'],
            { env: { ...runtimeEnv, SS_CMD_PID: String(child.pid) }, windowsHide: true });
        assert.match(managed.stdout.trim(), /^[0-9]+$/);
        const ended = new Promise(resolve => child.once('exit', resolve));
        await execute(path.join(system, 'System32/taskkill.exe'), ['/PID', managed.stdout.trim(), '/F'], { windowsHide: true });
        await Promise.race([ended, delay(5000).then(() => { throw new Error('Start.cmd did not finish after its launcher stopped'); })]);
        child = null;
        await assert.rejects(request(port, ca, '/api/network-sample'));
        const configPath = path.join(root, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath));
        // Do not mistake another process listening on the same port for readiness.
        busyPort = net.createServer();
        await new Promise((resolve, reject) => { busyPort.once('error', reject); busyPort.listen(port, '0.0.0.0', resolve); });
        await assert.rejects(execute(powershell, launcherArgs, { cwd: root, env: runtimeEnv, windowsHide: true, timeout: 15000 }), error => error.code === 1);
        await new Promise(resolve => busyPort.close(resolve)); busyPort = null;
        config.listenAdress = config.listenAddress;
        fs.writeFileSync(configPath, JSON.stringify(config));
        await assert.rejects(execute(powershell, launcherArgs, { cwd: root, env: runtimeEnv, windowsHide: true, timeout: 15000 }), error => error.code === 1);
    }
    console.log(JSON.stringify({ target: metadata.target, version: metadata.version, extractedPackage: true,
        tlsVerified: true, pagesVerified: 5, sdkFreeRuntimePath: true, unicodeAndSpacePath: true, startCmdTested: windows,
        certificateTrustChanged: false, firewallChanged: false, serialHardwareTested: false }, null, 2));
})().catch(error => { console.error(error); if (output) console.error(output); process.exitCode = 1; }).finally(async () => {
    try { await stopChild(); } catch (error) { console.error(error); process.exitCode = 1; }
    if (busyPort) busyPort.close();
    const parent = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(temporary);
    if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('shareserial-package-smoke-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
