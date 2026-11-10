import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
export const home=process.env.HOME||'/home/node';
export const workspace=path.join(home,'dsh');
export const state=path.join(home,'.clawchat-dsh');
export const connectConfig=path.join(home,'.clawchat-connect/config.json');
export const modelPatch=path.join(state,'models.patch.yml');
export const releaseRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const connectBin=path.join(releaseRoot,'clawchat-connect');
export const bridgePath=path.join(releaseRoot,'runtime/dsh-bridge.sh');
export const dshBin='/opt/dsh/node_modules/.bin/dsh';
export function readJSON(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function writeJSON(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);
}
export function nativeModel(){
 const cfg=readJSON(path.join(state,'config.json'));
 const providers=cfg.models?.providers||{};
 const primary=cfg.agents?.defaults?.model?.primary;
 if(typeof primary!=='string'||!primary.includes('/'))throw new Error('DSH model is not configured');
 const slash=primary.indexOf('/');const provider=primary.slice(0,slash),model=primary.slice(slash+1);
 if(!providers[provider])throw new Error('DSH configured provider is missing');
 let dotenv={};try{dotenv=parseEnv(fs.readFileSync(path.join(state,'.env'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const env={...process.env,DSH_PERMISSION_MODE:'danger-full-access'};
 for(const key of ['AGENT_MANAGER_TOKEN','CLAWCLOUD_TOKEN','CLAWCHAT_INTERNAL_API_TOKEN','INTERNAL_AUTH_TOKEN'])delete env[key];
 const nativeProviders={};
 for(const [id,value] of Object.entries(providers)){
  const envKey='CLAWCHAT_DSH_KEY_'+createHash('sha256').update(id).digest('hex').slice(0,16).toUpperCase();
  const credential=value.apiKey;
  env[envKey]=typeof credential==='string'?credential:(credential?.source==='env'?dotenv[credential.id]||env[credential.id]||'':'');
  nativeProviders[id]={apiKeyEnv:envKey,api:value.api||'openai-completions',...(value.baseUrl?{baseURL:value.baseUrl}:{}),models:(value.models||[]).map(m=>({id:m.id,name:m.name||m.id,contextWindow:m.contextWindow||32768,maxTokens:m.maxTokens||8192,reasoning:m.reasoning||false}))};
 }
 writeJSON(modelPatch,[
  {id:'llm-pi-ai',config:{providers:nativeProviders}},
  {id:'agent-default-model',config:{provider,model}},
  {id:'sandbox-policy',config:{mode:env.DSH_PERMISSION_MODE,workspaceRoot:workspace}},
  {id:'approval',config:{policy:'never'}},
  {id:'permission',config:{defaultPreset:env.DSH_PERMISSION_MODE,presets:{
   'read-only':{sandbox:'read-only',approval:'ask'},
   'workspace-write':{sandbox:'workspace-write',approval:'ask'},
   'danger-full-access':{sandbox:'danger-full-access',approval:'never'},
  }}},
  {insert:[{id:'clawnest-permission',name:path.join(path.dirname(fileURLToPath(import.meta.url)),'permission-mode.mjs')}]},
 ]);
 return {env,provider,model};
}
