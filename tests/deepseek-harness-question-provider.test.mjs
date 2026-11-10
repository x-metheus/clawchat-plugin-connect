import { describe, expect, it } from "bun:test";
import { registerQuestionProviderWhenProfileReady } from "../src/plugin/official/deepseek-harness-question-provider.mjs";

class QuestionService {
  provider;

  registerProvider(provider) {
    if (this.provider) {
      const error = new Error("a user-questions provider is already registered");
      error.code = "DUPLICATE_PROVIDER";
      throw error;
    }
    this.provider = provider;
    return () => {
      if (this.provider === provider) this.provider = undefined;
    };
  }
}

function profileContext(service) {
  let settle;
  const ready=new Promise(resolve=>{settle=resolve});
  let cleanup;
  const handlers=new Map();
  const ctx={
    root:{get:name=>name==="userQuestions"?service:name==="loader"?{await:()=>ready}:undefined},
    inject(dependencies,callback){
      expect(dependencies).toEqual(["loader"]);
      cleanup=callback(this);
      expect(cleanup instanceof Promise).toBe(false);
      return {async dispose(){await cleanup?.();}};
    },
    on(name,callback){handlers.set(name,callback);return()=>handlers.delete(name);},
  };
  return {ctx,handlers,async settleProfile(){settle();await ready;}};
}

describe("DeepSeek Harness question provider arbitration", () => {
  it("leaves a native provider authoritative when it registers during Profile loading", async () => {
    const service = new QuestionService();
    const profile = profileContext(service);
    const connectProvider = { ask: async () => ({ answers: [] }) };
    const registration = registerQuestionProviderWhenProfileReady(profile.ctx, connectProvider);
    const nativeProvider = { ask: async () => ({ answers: [] }) };

    const offNative = service.registerProvider(nativeProvider);
    await profile.settleProfile();

    await expect(registration.ready).resolves.toBe(false);
    expect(service.provider).toBe(nativeProvider);
    await registration.dispose();
    expect(service.provider).toBe(nativeProvider);
    offNative();
  });

  it("registers Connect only after a Profile settles with a free slot", async () => {
    const service = new QuestionService();
    const profile = profileContext(service);
    const connectProvider = { ask: async () => ({ answers: [] }) };
    const registration = registerQuestionProviderWhenProfileReady(profile.ctx, connectProvider);

    expect(service.provider).toBeUndefined();
    await profile.settleProfile();

    await expect(registration.ready).resolves.toBe(true);
    expect(service.provider).toBe(connectProvider);
    await registration.dispose();
    expect(service.provider).toBeUndefined();
  });
});

describe("rc.1 question waterfall",()=>{
 it("uses Connect only after native NO_PROVIDER for an owned root",async()=>{
  const profile=profileContext({});let calls=0;
  const registration=registerQuestionProviderWhenProfileReady(profile.ctx,{owns:r=>r.agent==="owned",ask:async()=>{calls++;return {answers:[]}}});
  await profile.settleProfile();await expect(registration.ready).resolves.toBe(true);
  const handler=profile.handlers.get("user-questions/request");
  const missing=()=>Promise.reject(Object.assign(new Error("no provider"),{code:"NO_PROVIDER"}));
  await expect(handler({agent:"owned"},async()=>({native:true}))).resolves.toEqual({native:true});
  expect(calls).toBe(0);
  await expect(handler({agent:"other"},missing)).rejects.toMatchObject({code:"NO_PROVIDER"});
  await expect(handler({agent:"owned"},async()=>{throw Object.assign(new Error("cancelled"),{code:"CANCELLED"})})).rejects.toMatchObject({code:"CANCELLED"});
  await expect(handler({agent:"owned"},missing)).resolves.toEqual({answers:[]});
  expect(calls).toBe(1);await registration.dispose();expect(profile.handlers.size).toBe(0);
 });
 it("does not register a provider after disposal while the loader is settling",async()=>{
  const profile=profileContext(new QuestionService());
  const registration=registerQuestionProviderWhenProfileReady(profile.ctx,{ask:async()=>({answers:[]})});
  await registration.dispose();await profile.settleProfile();await expect(registration.ready).resolves.toBe(false);
 });
});
