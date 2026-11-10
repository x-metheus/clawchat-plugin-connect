import {describe,it,expect} from 'bun:test';
import {greetingOwner,greetingPrompt,reusableGreetingDraft} from '../platform/deepseek-harness/greeting.mjs';
describe('DSH initial greeting locale',()=>{
 it.each(['en-US','es-ES','ja-JP','ko-KR','zh-CN','zh-TW','zh_Hant'])('uses the reported owner locale %s before generating the first greeting',locale=>{
  const owner=greetingOwner({id:'owner',nickname:'Owner',locale},'owner');const prompt=greetingPrompt(owner,'Keep it brief.');
  expect(prompt).toContain(JSON.stringify(Intl.getCanonicalLocales(locale.replaceAll('_','-'))[0]));expect(prompt).not.toContain('Preferred language: "zh-CN"');
 });
 it('uses the owner-approved English fallback only when no locale was reported',()=>{
  const owner=greetingOwner({id:'owner',nickname:'Owner',locale:null},'owner');expect(owner.locale).toBe('en');expect(owner.localeSource).toBe('default');expect(greetingPrompt(owner,'hello')).toContain('Reply in the owner app language: \"en\"');
 });
 it('refuses another owner and refreshes an unsent draft when locale metadata changes',()=>{
  expect(()=>greetingOwner({id:'other',nickname:'Other',locale:'en'},'owner')).toThrow('mismatched');
  const owner=greetingOwner({id:'owner',nickname:'Owner',locale:'ja'},'owner');const draft={status:'complete',ownerId:'owner',locale:'en',text:'old'};
  expect(reusableGreetingDraft(draft,owner)).toBeNull();expect(reusableGreetingDraft({...draft,deliveryStarted:true},owner)).toMatchObject({text:'old'});
 });
});
