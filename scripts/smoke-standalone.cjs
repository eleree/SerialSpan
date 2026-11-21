// Windows single-file delivery acceptance. Application PATH is empty; no
// shell, developer tool or extracted helper is available to start the server.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Usage on Windows: node scripts/smoke-standalone.cjs <exe>');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shareserial-single-smoke-'));
const app = path.join(temporary, '单文件 空格 & 目录');
fs.mkdirSync(app);
let binary = path.join(app, 'ShareSerial 预览.exe');
fs.copyFileSync(process.argv[2], binary);
const env = {...process.env, PATH:'', LOCALAPPDATA:path.join(temporary,'LocalAppData')};
const data = path.join(env.LOCALAPPDATA,'ShareSerial');
let child, busy;
let output = '';

function launch(args, input) {
    child = spawn(binary,args,{cwd:app,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    child.stdout.on('data', chunk=>{output=(output+chunk.toString()).slice(-16384)});
    child.stderr.on('data', chunk=>{output=(output+chunk.toString()).slice(-16384)});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    return child;
}

async function stop() {
    if (!child || child.exitCode!==null) {child=null;return;}
    const active=child;
    const ended=new Promise(resolve=>active.once('exit',resolve));
    active.kill();
    await Promise.race([ended,delay(5000).then(()=>{throw Error('single EXE did not stop')})]);
    child=null;
}

function request(port, ca, page) {
    return new Promise((resolve,reject)=>{
        const req=https.get({hostname:'127.0.0.1',port,path:page,ca,rejectUnauthorized:true,agent:false,timeout:1500},res=>{
            const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));
        });
        req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTPS timeout')));
    });
}

async function waitReady(port, ca) {
    for(let i=0;i<150;i++){
        assert.equal(child.exitCode,null,'EXE exited: '+output);
        try{if((await request(port,ca,'/api/network-sample')).status===204)return;}catch{}
        await delay(150);
    }
    throw Error('Single EXE never became ready: '+output);
}

(async()=>{
    const version=await execute(binary,['-version'],{env,cwd:app,windowsHide:true});
    const metadata=JSON.parse(version.stdout);
    const declared=fs.readFileSync(path.join(__dirname,'../VERSION'),'utf8').trim();
    assert.equal(metadata.version,declared,'CLI version must match the source release version');
    assert(version.stdout.includes('"target": "windows/'+(process.arch==='x64'?'amd64':process.arch)+'"'));
    if(process.argv.includes('--file-version')){
        const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
        const result=await execute(powershell,['-NoLogo','-NoProfile','-Command','[Diagnostics.FileVersionInfo]::GetVersionInfo($env:SS_VERSION_EXE) | Select-Object FileVersion,ProductVersion,ProductName | ConvertTo-Json'],
            {env:{...process.env,SS_VERSION_EXE:binary},windowsHide:true});
        const info=JSON.parse(result.stdout);
        assert.equal(info.FileVersion,declared);assert.equal(info.ProductVersion,declared);assert.equal(info.ProductName,'ShareSerial');
    }
    const notices=await execute(binary,['-licenses'],{env,cwd:app,windowsHide:true,maxBuffer:1024*1024});
    assert(notices.stdout.includes('licenses/go/LICENSE-Go.txt'));
    assert(notices.stdout.includes('gin-gonic/gin'));
    assert(notices.stdout.includes('esptool-js-0.7.0.LICENSE.txt'));
    assert(!fs.existsSync(data),'reading notices must not create a runtime installation');
    const reserve=net.createServer();
    await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
    const port=reserve.address().port;
    await new Promise(resolve=>reserve.close(resolve));
    // Use the real interactive first-run path, declining OS trust/firewall
    // changes. Only automatic browser opening is disabled for this test.
    launch(['-lan','-no-browser'],`127.0.0.1\n${port}\nNO\nNO\n`);
    for(let i=0;i<100&&!fs.existsSync(path.join(data,'config.json'));i++){
        assert.equal(child.exitCode,null,output);await delay(100);
    }
    const config=JSON.parse(fs.readFileSync(path.join(data,'config.json')));
    const certPath=path.join(data,config.certificate);
    const ca=fs.readFileSync(certPath);
    const cert=new crypto.X509Certificate(ca);
    assert.equal(cert.ca,false);
    assert.equal(crypto.createHash('sha256').update(cert.raw).digest('hex'),config.certificateSHA256);
    assert(fs.readFileSync(path.join(data,'ShareSerial-LAN.cer')).equals(cert.raw));
    await waitReady(port,ca);
    for(const page of ['/local','/remote','/remote/esp32','/static/js/i18n.js','/static/js/esp32-flasher.js','/static/vendor/esptool-js-0.7.0.js']){
        const response=await request(port,ca,page);assert.equal(response.status,200,page);assert(response.body.length>0);
    }
    await stop();
    await assert.rejects(request(port,ca,'/api/network-sample'));
    assert.deepEqual(fs.readdirSync(app),[path.basename(binary)],'app extracted sidecar programs or scripts');
    const runtime=fs.readdirSync(data,{recursive:true});
    assert(!runtime.some(name=>/\.(exe|dll|ps1|cmd|go)$/i.test(name)),'runtime directory contains extracted application code');
    const original=fs.readFileSync(certPath);
    const renamed=path.join(app,'ShareSerial 改名后.exe');fs.renameSync(binary,renamed);binary=renamed;
    const args=['-lan','-no-browser','-no-trust','-no-firewall','-non-interactive'];
    launch(args);await waitReady(port,ca);await stop();
    assert(fs.readFileSync(certPath).equals(original),'renaming/updating the EXE lost the persistent identity');
    busy=net.createServer();await new Promise(resolve=>busy.listen(port,'0.0.0.0',resolve));
    await assert.rejects(execute(binary,args,{env,cwd:app,windowsHide:true,timeout:10000}),error=>error.code===1);
    await new Promise(resolve=>busy.close(resolve));busy=null;
    fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({...config,certificateSHA256:'0'.repeat(64)}));
    await assert.rejects(execute(binary,args,{env,cwd:app,windowsHide:true,timeout:10000}),error=>error.code===1);
    console.log(JSON.stringify({version:metadata.version,windowsFileVersionChecked:process.argv.includes('--file-version'),singleExecutable:true,firstRunConsole:true,emptyRuntimePATH:true,pagesVerified:5,tlsVerified:true,
        noExtractedCode:true,embeddedNotices:true,restartAndRenamePreserveConfig:true,busyPortRejected:true,
        staleCertificateRejected:true,certificateTrustChanged:false,firewallChanged:false,hardwareTested:false},null,2));
})().catch(error=>{console.error(error);console.error(output);process.exitCode=1}).finally(async()=>{
    await stop();if(busy)busy.close();
    const parent=fs.realpathSync(os.tmpdir()),target=fs.realpathSync(temporary);
    if(path.dirname(target)===parent&&path.basename(target).startsWith('shareserial-single-smoke-'))fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:200});
});
