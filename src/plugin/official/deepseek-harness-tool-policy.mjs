const clawChatName = name => typeof name === 'string' && /^clawchat_[a-zA-Z0-9_]+$/.test(name);

// Parse only literal words and a single printf pipe. No shell expansion or chaining.
function shellWords(command) {
  if (typeof command !== 'string' || command.length > 1_048_576) return null;
  const words = []; let word = '', quote = null, started = false;
  const flush = () => { if (started) words.push({kind:'word', value:word}); word=''; started=false; };
  for (let i=0; i<command.length; i++) {
    const c=command[i];
    if (quote === "'") { if(c === "'") quote=null; else word+=c; continue; }
    if (quote === '"') {
      if(c === '"') quote=null;
      else if(c === '$' || c === '`') return null;
      else if(c === '\\') {const next=command[++i];if(next===undefined||next==='\n'||next==='\r')return null;word+=['"','\\','$','`'].includes(next)?next:'\\'+next;}
      else word+=c;
      continue;
    }
    if(c === "'" || c === '"') {quote=c;started=true;continue;}
    if(c === '\\') {const next=command[++i];if(next===undefined||next==='\n'||next==='\r')return null;word+=next;started=true;continue;}
    if(c === '\n' || c === '\r' || /[;&<>()$`#*?\[\]{}!~]/.test(c)) return null;
    if(c === '|') {flush();words.push({kind:'pipe'});continue;}
    if(c===' '||c==='\t') {flush();continue;}
    if(/\s/.test(c)||c.charCodeAt(0)<32||c.charCodeAt(0)===127)return null;
    word+=c;started=true;
  }
  if(quote) return null;flush();return words;
}

export function isClawChatToolCommand(command, configPath) {
  const tokens=shellWords(command);if(!tokens?.length)return false;
  const pipes=tokens.filter(token=>token.kind==='pipe');if(pipes.length>1)return false;
  let input,words=tokens;
  if(pipes.length) {
    const split=tokens.findIndex(token=>token.kind==='pipe');const prefix=tokens.slice(0,split).map(token=>token.value);
    if(prefix.length!==3||prefix[0]!=='printf'||prefix[1]!=='%s')return false;
    input=prefix[2];words=tokens.slice(split+1);
  }
  const argv=words.map(token=>token.value);
  if(!['clawchat-connect','/usr/local/bin/clawchat-connect'].includes(argv[0])||argv[1]!=='tool'||argv[2]!=='call'||!clawChatName(argv[3]))return false;
  const flags=new Map();
  for(let i=4;i<argv.length;i+=2) {
    const flag=argv[i],value=argv[i+1];
    if(!['--input-json','--agent','--request-id','--config'].includes(flag)||value===undefined||flags.has(flag))return false;
    if(flag==='--config'&&(!configPath||value!==configPath))return false;
    flags.set(flag,value);
  }
  if(!flags.has('--input-json'))return false;
  if(pipes.length ? flags.get('--input-json')!=='-' : flags.get('--input-json')==='-')return false;
  try {const value=JSON.parse(pipes.length?input:flags.get('--input-json'));return value!==null&&typeof value==='object'&&!Array.isArray(value);}catch{return false;}
}

/** Owner standing permission: ClawChat calls never reach an interactive answerer. */
export function registerClawChatApprovalPolicy(ctx,{owns,ask,configPath}) {
  const calls=new WeakMap();
  const remember=(agent,call)=>{
    if(!owns(agent)||!call?.callId)return;
    let active=calls.get(agent);if(!active){active=new Map();calls.set(agent,active);}
    active.set(call.callId,call);
    if(active.size>128)active.delete(active.keys().next().value);
  };
  const offPre=ctx.on('tools/pre-execute',async(exec,next)=>{remember(exec.agent,exec);return await next();});
  const offResult=ctx.on('tools/result',exec=>{calls.get(exec.agent)?.delete(exec.callId);});
  const offApproval=ctx.on('approval/request',async(request,next)=>{
    if(!owns(request.agent))return await next();
    const call=calls.get(request.agent)?.get(request.callId);
    const permitted=clawChatName(request.toolName)||(request.toolName==='bash'&&call?.name==='bash'&&isClawChatToolCommand(call.arguments?.command,configPath));
    if(permitted)return request.signal?.aborted?'cancelled':'allowed-once';
    return await ask(request,next);
  });
  return {
    observe(agent,event){
      if(event.type==='tool/call') {
        try{remember(agent,{...event.data,arguments:JSON.parse(event.data.arguments)});}catch{}
      } else if(event.type==='tool/result')calls.get(agent)?.delete(event.data.message?.source?.callId);
    },
    dispose(){offApproval();offPre();offResult();},
  };
}
