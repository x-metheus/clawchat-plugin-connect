#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createInterface} from 'node:readline';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {home,workspace,state,connectConfig,modelPatch,connectBin,dshBin,releaseRoot,bridgePath,readJSON,writeJSON,nativeModel} from './lib.mjs';
import {syncUpdaterSkill} from './update-skill.mjs';
import {greetingOwner,greetingPrompt,reusableGreetingDraft} from './greeting.mjs';
process.umask(0o077);
const args=process.argv.slice(2);
function connect(argv,options={}){
 try{return execFileSync(connectBin,[...argv,'--config',connectConfig],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,...(argv[0]==='agent'&&argv[1]==='add'?{env:nativeModel().env}:{}),...options});}
 catch{throw new Error('ClawChat Connect command failed: '+argv.slice(0,2).join('/'));}
}
function safeStatus(prepare=false){return JSON.parse(connect(['__clawnest-state',...(prepare?['--prepare-workspace']:[])]));}
function initialize(){
 fs.mkdirSync(workspace,{recursive:true,mode:0o700});fs.mkdirSync(state,{recursive:true,mode:0o700});nativeModel();
 if(!fs.existsSync(connectConfig)){
  connect(['init']);
  for(const [key,value] of [['baseUrl',process.env.CLAWCHAT_BASE_URL],['websocketUrl',process.env.CLAWCHAT_WEBSOCKET_URL],['mediaUploadUrl',process.env.CLAWCHAT_MEDIA_URL]])if(value)connect(['config','set',key,value]);
 }
 // Verify/repair only the release-managed skills; user skills remain separate.
 connect(['skills','install']);
 syncUpdaterSkill(path.join(releaseRoot,'updater-skill'),path.join(home,'.agents/skills/clawnest-plugin-update'),path.join(state,'updater-skill-files.json'));
 // Refresh installed release-managed official components, preserving disabled/configured state.
 const installedPlugins=readJSON(path.join(path.dirname(connectConfig),'plugins.lock.json')).plugins||{};
 for(const packaged of fs.readdirSync(path.join(releaseRoot,'official-plugins')).filter(name=>name.endsWith('.connect-plugin'))){
  const bundle=readJSON(path.join(releaseRoot,'official-plugins',packaged));
  const pluginId=bundle.manifest.pluginId;
  const installed=installedPlugins[pluginId];
  if(pluginId!=='clawling.runtime.deepseek-harness'&&!installed)continue;
  const expected=bundle.manifest.artifacts[0].integrity;
  const directory=installed?.manifestPath?path.dirname(installed.manifestPath):null;
  const matches=installed?.integrity===expected&&directory&&Object.entries(bundle.files).every(([entry,file])=>{
   const target=path.resolve(directory,entry);
   if(!target.startsWith(directory+path.sep)||!fs.existsSync(target))return false;
   const desired=Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8');
   return createHash('sha256').update(fs.readFileSync(target)).digest('hex')===createHash('sha256').update(desired).digest('hex');
  });
  if(!matches)connect(['plugin','setup','--non-interactive','--select',pluginId]);
 }
 const config=readJSON(connectConfig);
 const managed=config.agents?.dsh?.runtimeConfig;
 if(managed&&(managed.executablePathOverride==='/opt/clawnest-dsh/runtime/dsh-bridge.sh'||typeof managed.executablePathOverride==='string'&&managed.executablePathOverride.startsWith(path.join(home,'.clawnest-integrations/deepseek-harness/releases')+path.sep))){
  if(managed.executablePathOverride==='/opt/clawnest-dsh/runtime/dsh-bridge.sh'&&managed.profile==='web')managed.profile='sdk';
  managed.executablePathOverride=bridgePath;writeJSON(connectConfig,config);
 }
 if(!config.agents?.dsh){
  connect(['agent','add','dsh','--plugin','clawling.runtime.deepseek-harness','--capability','deepseek-harness','--runtime-config-json',JSON.stringify({profile:'sdk',homePath:path.join(home,'.dsh'),executablePathOverride:bridgePath})]);
  connect(['workspace','add','dsh',workspace]);
 }
}
function child(command,argv,env){
 const p=spawn(command,argv,{env,stdio:'inherit',cwd:workspace});
 for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>p.kill(sig));
 p.on('error',()=>{console.error('DSH subprocess could not start');process.exitCode=1;});
 p.on('exit',code=>{process.exitCode=code??1;});return p;
}
async function activate(){
 initialize();
 let code='';for await(const chunk of process.stdin)code+=chunk;code=code.trim();
 if(!/^[A-Za-z0-9]{8}$/.test(code))throw new Error('Invalid ClawChat connect code');
 // A platform initial attempt may have redeemed its code before being interrupted.
 // Core repairs an existing binding in place; continuity is checked below.
 const before=safeStatus();
 const output=connect(['activate','dsh',code]);
 const match=output.match(/^agent user: (usr_[0-9A-HJKMNP-TV-Z]{26})$/m);if(!match)throw new Error('Invalid ClawChat activation response');
 const after=safeStatus(true);
 if(process.env.CLAWCHAT_NICKNAME)connect(['profile','update','--agent','dsh','--nickname',process.env.CLAWCHAT_NICKNAME]);
 if(before.userId&&(before.userId!==after.userId||before.ownerId!==after.ownerId))throw new Error('ClawChat repair identity mismatch');
 console.log('clawchat: activation complete for '+match[1]);
}
async function sendInitialGreeting(after){
 // Sending the first greeting is an explicit, durable platform initialization step.
 if(!fs.existsSync(path.join(state,'greeting-receipt.json'))){
  const greetingPath=path.join(workspace,'clawchat/greeting.md');
  const instruction=fs.readFileSync(greetingPath,'utf8').trim();
  if(instruction){
   const owner=greetingOwner(JSON.parse(connect(['__clawnest-owner'])),after.ownerId);
   const draftPath=path.join(state,'greeting-draft.json');let draft=reusableGreetingDraft(readJSON(draftPath,null),owner);
   const ownerLocale=owner.locale;
   if(!draft||draft.status==='pending'){
    const native=nativeModel();const {DeepSeekHarness}=await import('/opt/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js');
    const harness=new DeepSeekHarness({dshBin:'/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',profile:'sdk',patches:[modelPatch],dshHome:path.join(home,'.dsh'),cwd:workspace,processCwd:workspace,provider:native.provider,model:native.model,env:native.env,initializeTimeoutMs:90000});
    const session=harness.session();writeJSON(draftPath,{sessionId:session.id,status:'pending'});
    try{const result=await session.run(greetingPrompt(owner,instruction));if(result.finishReason==='error'||!result.finalResponse?.trim())throw new Error('Greeting generation failed');draft={sessionId:session.id,status:'complete',ownerId:after.ownerId,locale:ownerLocale,text:result.finalResponse};writeJSON(draftPath,draft);}finally{await harness.close();}
   }
   if(draft.status!=='complete')throw new Error('Greeting generation outcome needs recovery');
   const text=draft.text;
   if(!draft.deliveryStarted){draft.deliveryStarted=true;writeJSON(draftPath,draft);}
   const requestId='dsh-greeting-'+createHash('sha256').update(after.userId).digest('hex').slice(0,24);
   const result=JSON.parse(connect(['tool','call','clawchat_mention_message','--agent','dsh','--request-id',requestId,'--input-json',JSON.stringify({chatId:after.conversationId,chatType:'direct',text,mentions:[{userId:after.ownerId,display:owner.nickname}]})]));
   if(!result.result?.messageId)throw new Error('ClawChat greeting acknowledgement missing');
   writeJSON(path.join(state,'greeting-receipt.json'),{requestId,messageId:result.result.messageId});
  }
 }
}
async function serve(){
 initialize();const model=nativeModel();
 let core=null;
 function startCore(){
  if(core)return;
  core=spawn(connectBin,['service','exec','--config',connectConfig],{env:{...model.env,CLAWCHAT_PRESERVE_PUBLICATIONS_ON_SHUTDOWN:'1',CLAWCHAT_CONNECT_CONFIG:connectConfig},cwd:workspace,stdio:['ignore','pipe','pipe']});
  for(const stream of [core.stdout,core.stderr])createInterface({input:stream}).on('line',line=>{
   const text=line.replace(/([?&]token=)[^&\s]+/g,'$1[redacted]');process.stderr.write(text+'\n');
  });
  core.on('exit',()=>void stop(1));core.on('error',()=>void stop(1));
 }
 const startedAt=Date.now();let draining=false;let drainPromise=null;let activeBrowserRequests=0;
 const token=process.env.AGENT_MANAGER_TOKEN||process.env.CLAWCLOUD_TOKEN;
 if(!token)throw new Error('Manager authentication is required');
 const sessions=new Map();const mappingPath=path.join(state,'operator-sessions.json');const persisted=readJSON(mappingPath);
 const {DeepSeekHarness}=await import('/opt/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js');
 const handleRequest=async(req,res,trustedUpdate=false)=>{
  const supplied=(req.headers.authorization||'').replace(/^Bearer /,'');
  if(!trustedUpdate&&(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))){res.writeHead(401);return res.end('Unauthorized');}
  if(req.url==='/integration/health'){
   const status=safeStatus();const ready=!draining&&(!status.userId||(status.updatedAt>=startedAt&&status.connected&&status.available));
   res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ready,version:process.env.CLAWNEST_INTEGRATION_VERSION,identity:status.userId,connected:status.connected,draining}));
  }
  if(req.url==='/integration/resume'&&req.method==='POST'){
   try{
    if(drainPromise)await drainPromise.catch(()=>{});
    if(core?.exitCode===null){const result=await fetch('http://127.0.0.1:47822/core/v1/bindings/resume',{method:'POST',headers:{'X-ClawChat-Connect-Core-Config-Path':connectConfig}});if(!result.ok)throw new Error('Core could not resume');}
    draining=false;drainPromise=null;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({resumed:true}));
   }catch{res.writeHead(503);res.end();}return;
  }
  if(req.url==='/integration/drain'&&req.method==='POST'){
   draining=true;
   drainPromise??=(async()=>{
    while(activeBrowserRequests>0||[...sessions.values()].some(entry=>entry.running)||greetingRunning)await new Promise(r=>setTimeout(r,50));
    if(core?.exitCode===null){const result=await fetch('http://127.0.0.1:47822/core/v1/bindings/quiesce',{method:'POST',headers:{'Content-Type':'application/json','X-ClawChat-Connect-Core-Config-Path':connectConfig},body:JSON.stringify({bindingIds:['dsh']})});if(!result.ok)throw new Error('Core could not quiesce the binding');}
   })();
   try{await drainPromise;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({drained:true}));}catch{res.writeHead(503);res.end();}return;
  }
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,connectProcess:core?.exitCode===null}));}
  if(draining){res.writeHead(503);return res.end('Agent is updating; try again shortly.');}
  if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();}
  activeBrowserRequests++;
  let conversation,entry;
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1<<20)throw new Error('request too large');}
   const body=JSON.parse(raw);const messages=body.messages||[];const latest=messages.findLast(m=>m.role==='user');
   const prompt=typeof latest?.content==='string'?latest.content:Array.isArray(latest?.content)?latest.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';
   if(!prompt.trim()){res.writeHead(400);return res.end(JSON.stringify({error:{message:'A text user message is required'}}));}
   const id=String(body.conversation_id||body.session_id||randomUUID());conversation=createHash('sha256').update(id).digest('hex');entry=sessions.get(conversation);
   if(entry?.running){res.writeHead(409);return res.end(JSON.stringify({error:{message:'Conversation is busy'}}));}
   if(!entry){
    if(sessions.size>=2){const idle=[...sessions.entries()].find(([,s])=>!s.running);if(!idle){res.writeHead(429);return res.end();}await idle[1].harness.close();sessions.delete(idle[0]);}
    const harness=new DeepSeekHarness({dshBin:'/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',profile:'sdk',patches:[modelPatch],dshHome:path.join(home,'.dsh'),cwd:workspace,processCwd:workspace,provider:model.provider,model:model.model,env:model.env,initializeTimeoutMs:90000});
    try{const session=persisted[conversation]?await harness.resumeSession(persisted[conversation]):harness.session();entry={harness,session,running:false};sessions.set(conversation,entry);persisted[conversation]=session.id;writeJSON(mappingPath,persisted);}catch(error){await harness.close();throw error;}
   }
   entry.running=true;const completionId='chatcmpl-'+randomUUID();let sent='';
   const send=delta=>res.write('data: '+JSON.stringify({id:completionId,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:model.model,choices:[{index:0,delta:{content:delta},finish_reason:null}]})+'\n\n');
   if(body.stream)res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
   const live=entry;res.on('close',()=>{if(!res.writableEnded){sessions.delete(conversation);void live.harness.close();}});
   const result=await entry.session.run(prompt,{onNotification:n=>{
    if(n.method!=='session.event'||n.params?.sessionId!==entry.session.id)return;
    const e=n.params.event;if(e.type==='assistant/chunk'&&e.data?.chunk?.type==='text-delta'){const text=e.data.chunk.text;sent+=text;if(body.stream)send(text);}
   }});
   if(result.finishReason==='error')throw new Error('DSH turn failed');
   if(body.stream){if(!sent&&result.finalResponse)send(result.finalResponse);res.write('data: '+JSON.stringify({id:completionId,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}
   else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:completionId,object:'chat.completion',model:model.model,choices:[{index:0,message:{role:'assistant',content:result.finalResponse},finish_reason:'stop'}]}));}
  }catch{
   if(entry){sessions.delete(conversation);await entry.harness.close().catch(()=>{});}
   if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'DeepSeek Harness turn unavailable'}}));}else res.end('data: '+JSON.stringify({error:{message:'DeepSeek Harness turn unavailable'}})+'\n\n');
  }finally{activeBrowserRequests--;if(entry)entry.running=false;}
 };
 const server=http.createServer((req,res)=>void handleRequest(req,res));
 await new Promise(resolve=>server.listen(18789,'127.0.0.1',resolve));
 const controlPath=path.join(home,'.clawnest-integrations/deepseek-harness/control.sock');
 fs.mkdirSync(path.dirname(controlPath),{recursive:true,mode:0o700});
 if(fs.existsSync(controlPath))fs.unlinkSync(controlPath);
 const controlServer=http.createServer((req,res)=>{
  if(!['/integration/health','/integration/drain','/integration/resume'].includes(req.url)){res.writeHead(404);res.end();return;}
  void handleRequest(req,res,true);
 });
 await new Promise(resolve=>controlServer.listen(controlPath,resolve));fs.chmodSync(controlPath,0o600);
 // The service owns greeting delivery; activation only redeems and validates identity.
 let greetingRunning=false;
 const greetingTimer=setInterval(async()=>{
  if(greetingRunning||draining)return;
  greetingRunning=true;
  try{const status=safeStatus(true);if(status.userId){startCore();if(status.connected&&!fs.existsSync(path.join(state,'greeting-receipt.json')))await sendInitialGreeting(status);}}
  catch{console.error('Initial greeting delivery is pending; inspect the durable greeting state');}
  finally{greetingRunning=false;}
 },5000);

 let stopping=false;
 async function stop(code=0){if(stopping)return;stopping=true;clearInterval(greetingTimer);server.close();controlServer.close();try{fs.unlinkSync(controlPath);}catch{}core?.kill('SIGTERM');await Promise.allSettled([...sessions.values()].map(s=>s.harness.close()));setTimeout(()=>{core?.kill('SIGKILL');process.exit(code);},3000).unref();}
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
 if(process.send)process.on('disconnect',()=>void stop());
}
async function main(){
 switch(args[0]){
  case 'init':initialize();nativeModel();break;
  case 'activate':await activate();break;
  case 'status':console.log(JSON.stringify(safeStatus()));break;
  case 'serve':await serve();break;
  case 'web':{
   const i=args.indexOf('--public-url');const raw=args[i+1];const url=new URL(raw);const model=nativeModel();
   const host=Object.values(os.networkInterfaces()).flat().find(n=>n?.family==='IPv4'&&!n.internal)?.address||'127.0.0.1';
   child(dshBin,['web','--patch',modelPatch,'--host',host,'--port','3080','--public-url',url.href,'--trusted-host',url.host,'--no-open'],model.env);break;
  }
  default:throw new Error('Expected init, activate, status, serve or web');
 }
}
main().catch(error=>{const detail=error.message?.startsWith('ClawChat Connect command failed: ')?error.message:'DeepSeek Harness platform operation failed';console.error(detail);process.exitCode=1;});
