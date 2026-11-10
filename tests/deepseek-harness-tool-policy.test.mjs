import {describe,it,expect} from 'bun:test';
import {isClawChatToolCommand,registerClawChatApprovalPolicy} from '../src/plugin/official/deepseek-harness-tool-policy.mjs';

describe('ClawChat standing approval permission',()=>{
 it.each([
  `clawchat-connect tool call clawchat_get_profile --input-json '{}'`,
  `/usr/local/bin/clawchat-connect tool call clawchat_liveware_login --input-json '{"x":"literal $(whoami); & |"}' --request-id once`,
  `printf '%s' '{"text":"literal $(whoami); & |"}' | clawchat-connect tool call clawchat_send_message --input-json -`,
  `clawchat-connect tool call clawchat_future_tool --input-json '{}' --agent dsh --config /home/node/.clawchat-connect/config.json`,
 ])('recognizes the exact ClawChat invocation: %s',command=>{expect(isClawChatToolCommand(command,'/home/node/.clawchat-connect/config.json')).toBe(true);});
 it.each([
  `clawchat-connect tool call clawchat_get_profile --input-json '{}' && touch /tmp/other`,
  `clawchat-connect tool call clawchat_get_profile --input-json '{}' > /tmp/out`,
  `clawchat-connect tool call clawchat_get_profile --input-json "$(touch /tmp/other)"`,
  `printf '%s' '{}' | clawchat-connect tool call clawchat_get_profile --input-json - | sh`,
  `printf '%s' '{}' | clawchat-connect tool call clawchat_get_profile --input-json '{}'`,
  `clawchat-connect plugin remove clawchat_get_profile --input-json '{}'`,
  `./clawchat-connect tool call clawchat_get_profile --input-json '{}'`,
  `clawchat-connect tool call clawchat_get_profile --input-json '{}' --config /tmp/other`,
  `clawchat-connect tool call other_tool --input-json '{}'`,
  `clawchat-connect tool call clawchat_get_profile --input-json '{}'\nwhoami`,
  `clawchat-connect tool call clawchat_get_profile --input-json '{}' --help`,
  `clawchat-connect\u00a0tool call clawchat_get_profile --input-json '{}'`,
  `clawchat-connect\vtool call clawchat_get_profile --input-json '{}'`,
 ])('keeps other shell operations under their normal policy: %s',command=>{expect(isClawChatToolCommand(command)).toBe(false);});
 it('silently allows every clawchat_ tool and its CLI escalation before interactive answerers',async()=>{
  const handlers=new Map();const agent={},other={};let prompts=0,nextCalls=0;
  const policy=registerClawChatApprovalPolicy({on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name);}},{owns:a=>a===agent,ask:async()=>{prompts++;return 'rejected';}});
  const approve=handlers.get('approval/request');const next=async()=>{nextCalls++;return 'unavailable';};
  expect(await approve({agent,toolName:'clawchat_any_future_function'},next)).toBe('allowed-once');
  policy.observe(agent,{type:'tool/call',data:{callId:'call',name:'bash',arguments:JSON.stringify({command:`clawchat-connect tool call clawchat_get_profile --input-json '{}'`})}});
  expect(await approve({agent,toolName:'bash',callId:'call'},next)).toBe('allowed-once');
  expect(prompts).toBe(0);expect(nextCalls).toBe(0);
  const cancelled=new AbortController();cancelled.abort();expect(await approve({agent,toolName:'clawchat_get_profile',signal:cancelled.signal},next)).toBe('cancelled');
  await approve({agent:other,toolName:'clawchat_get_profile'},next);expect(nextCalls).toBe(1);
  policy.observe(agent,{type:'tool/result',data:{message:{source:{callId:'call'}}}});await approve({agent,toolName:'bash',callId:'call'},next);expect(prompts).toBe(1);
  await handlers.get('tools/pre-execute')({agent,callId:'mixed',name:'bash',arguments:{command:`clawchat-connect tool call clawchat_get_profile --input-json '{}' ; whoami`}},next);
  await approve({agent,toolName:'bash',callId:'mixed'},next);expect(prompts).toBe(2);
  policy.dispose();expect(handlers.size).toBe(0);
 });
});
