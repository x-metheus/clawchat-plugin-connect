import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {apply} from '../platform/deepseek-harness/permission-mode.mjs';

it('generates one full-access startup patch for managed SDK and Web launches without editing user config',()=>{
 const home=mkdtempSync(join(tmpdir(),'dsh-permission-'));
 try{
  mkdirSync(join(home,'.clawchat-dsh'));
  const config=JSON.stringify({models:{providers:{fixture:{apiKey:'fixture-key',models:[{id:'fixture-model'}]}}},agents:{defaults:{model:{primary:'fixture/fixture-model'}}}});
  const file=join(home,'.clawchat-dsh/config.json');writeFileSync(file,config);
  const script=`import {nativeModel} from ${JSON.stringify(new URL('../platform/deepseek-harness/lib.mjs',import.meta.url).href)}; const {env}=nativeModel(); console.log(JSON.stringify({mode:env.DSH_PERMISSION_MODE,hasManagerToken:'AGENT_MANAGER_TOKEN' in env}));`;
  const result=spawnSync(process.execPath,['--eval',script],{encoding:'utf8',env:{...process.env,HOME:home,DSH_PERMISSION_MODE:'workspace-write',AGENT_MANAGER_TOKEN:'private-fixture'}});
  expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({mode:'danger-full-access',hasManagerToken:false});
  const patch=JSON.parse(readFileSync(join(home,'.clawchat-dsh/models.patch.yml'),'utf8'));
  expect(patch).toContainEqual({id:'sandbox-policy',config:{mode:'danger-full-access',workspaceRoot:join(home,'dsh')}});
  expect(patch).toContainEqual({id:'approval',config:{policy:'never'}});
  expect(patch.find(p=>p.id==='permission').config).toMatchObject({defaultPreset:'danger-full-access',presets:{'read-only':{sandbox:'read-only',approval:'ask'}}});
  expect(patch.flatMap(p=>p.insert||[]).find(p=>p.id==='clawnest-permission').name).toEndWith('/platform/deepseek-harness/permission-mode.mjs');
  expect(readFileSync(file,'utf8')).toBe(config);
 }finally{rmSync(home,{recursive:true});}
});

it('uses native setters on existing and newly restored agents without replacing session data or locking later choices',()=>{
 const old={id:'persisted',history:['earlier message'],mode:'workspace-write'},fresh={id:'new',history:[],mode:'read-only'};
 let onCreated;
 const ctx={permissionPresets:{set(session,mode){session.mode=mode;session.preset=mode;},permissionState(session){return {preset:session.preset};}},agents:{list:()=>[{session:old}]},on(event,listener,options){expect(event).toBe('agent/created');expect(options).toEqual({prepend:true});onCreated=listener;}};
 apply(ctx);expect(old).toEqual({id:'persisted',history:['earlier message'],mode:'danger-full-access',preset:'danger-full-access'});
 onCreated({agent:{session:fresh}});expect(fresh.mode).toBe('danger-full-access');
 ctx.permissionPresets.set(fresh,'read-only');expect(fresh.mode).toBe('read-only');
});

it('normalizes a delegated Auto identity when native set sees already matching full/never knobs',()=>{
 const events=[];const session={preset:'auto',append(type,data){events.push({type,data});this.preset=data.preset;}};
 const ctx={permissionPresets:{set(){},permissionState(s){return {preset:s.preset};}},agents:{list:()=>[{session}]},on(){}};
 apply(ctx);expect(events).toEqual([{type:'permission/preset',data:{preset:'danger-full-access'}}]);
 apply(ctx);expect(events).toHaveLength(1);
});
