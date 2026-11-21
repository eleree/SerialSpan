// Native Chromium/CDP driver for repository acceptance checks (Node 24, no npm).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function launch(){
    const executable=process.env.P2P_CHROME||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(file=>fs.existsSync(file));
    if(!executable)throw Error('Set P2P_CHROME to a Chromium executable');
    const temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'shareserial-serial-browser-'));
    let child,socket;const pending=new Map(),wire=[],errors=[],bindings=new Map();let next=0;
    async function close(){
        if(socket?.readyState===WebSocket.OPEN){await command('Browser.close').catch(()=>{});socket.close()}
        if(child&&child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)]);if(child.exitCode===null)child.kill()}
        for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Browser closed'))}pending.clear();
        if(process.platform==='win32'){
            const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
            await execute(powershell,['-NoLogo','-NoProfile','-Command',"Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','msedge.exe') -and $_.CommandLine -and $_.CommandLine.Contains($env:SS_SERIAL_TEST_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"],{env:{...process.env,SS_SERIAL_TEST_PROFILE:temporary},windowsHide:true}).catch(()=>{});
        }
        const parent=fs.realpathSync(os.tmpdir()),target=fs.realpathSync(temporary);
        if(path.dirname(target)!==parent||!path.basename(target).startsWith('shareserial-serial-browser-'))throw Error('Unsafe browser profile cleanup path');
        for(let i=0;i<40;i++){try{fs.rmSync(target,{recursive:true,force:true});break}catch(error){if(i===39)throw error;await delay(250)}}
    }
    function command(method,params={},sessionId){return new Promise((resolve,reject)=>{
        const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},20000);
        pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));
    })}
    try{
        const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
        const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
        child=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server','--ignore-certificate-errors','--remote-debugging-port='+port,'--user-data-dir='+temporary,'about:blank'],{stdio:'ignore',windowsHide:true});
        child.on('error',error=>errors.push(error.message));
        let info;for(let i=0;i<100;i++){try{info=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();break}catch{await delay(100)}}
        if(!info)throw Error('Chromium did not start: '+errors.join(';'));
        socket=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
        socket.addEventListener('message',event=>{
            const m=JSON.parse(event.data);if(m.id&&pending.has(m.id)){const item=pending.get(m.id);pending.delete(m.id);clearTimeout(item.timer);m.error?item.reject(Error(JSON.stringify(m.error))):item.resolve(m.result)}
            if(m.method==='Network.webSocketFrameSent'||m.method==='Network.webSocketFrameReceived'){try{wire.push({session:m.sessionId,sent:m.method.endsWith('Sent'),message:JSON.parse(m.params.response.payloadData)})}catch{}}
            if(m.method==='Runtime.exceptionThrown')errors.push(JSON.stringify(m.params.exceptionDetails));
            if(m.method==='Runtime.bindingCalled'){
                const callback=bindings.get(m.sessionId+':'+m.params.name);
                if(callback)Promise.resolve().then(()=>callback(m.params.payload,m.sessionId)).catch(error=>errors.push(error.message));
            }
        });
        async function evaluate(session,expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
        async function wait(session,expression,timeoutMs=30000){for(let i=0;i<Math.ceil(timeoutMs/100);i++){const result=await evaluate(session,expression);if(result)return result;await delay(100)}throw Error('Browser wait timed out: '+expression+'; '+errors.join(';'))}
        async function page(url,source='',loadTimeoutMs=30000){
            const {browserContextId}=await command('Target.createBrowserContext'),{targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
            const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
            for(const method of ['Page.enable','Runtime.enable','Network.enable'])await command(method,{},sessionId);
            await command('Security.setIgnoreCertificateErrors',{ignore:true},sessionId);
            if(source)await command('Page.addScriptToEvaluateOnNewDocument',{source},sessionId);
            await command('Page.navigate',{url},sessionId);await wait(sessionId,"document.readyState==='complete'",loadTimeoutMs);return sessionId;
        }
        async function bind(session,name,callback){bindings.set(session+':'+name,callback);await command('Runtime.addBinding',{name},session)}
        return {version:info.Browser,command,evaluate,wait,page,bind,wire,errors,close,delay};
    }catch(error){await close();throw error}
}
module.exports={launch};
