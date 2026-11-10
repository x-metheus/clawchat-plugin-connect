export function registerQuestionProviderWhenProfileReady(ctx, provider) {
  let resolveReady;
  let rejectReady;
  let settled = false;
  let disposed = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const settle = (available) => {
    if (settled) return;
    settled = true;
    resolveReady(available);
  };
  const registration = ctx.inject(["loader"], () => {
    let retired = false;
    let off;
    // The native loader includes injection fibers in its readiness barrier.
    // Await it outside that fiber so this provider cannot wait on itself.
    Promise.resolve().then(() => ctx.root.get("loader")?.await()).then(() => {
      if (disposed || retired) { settle(false); return; }
      try {
        off = registerQuestionProvider(ctx,ctx.root.get("userQuestions"), provider);
        settle(Boolean(off));
      } catch (error) {
        if (!settled) { settled = true; rejectReady(error); }
      }
    }, (error) => {
      if (!settled) { settled = true; rejectReady(error); }
    });
    return () => { retired = true; off?.(); };
  });
  return {
    ready,
    async dispose() {
      disposed = true;
      try {
        await registration.dispose();
      } finally {
        settle(false);
      }
    },
  };
}

function registerQuestionProvider(ctx,service, provider) {
  if (service && typeof service.registerProvider!=="function") {
    if(typeof provider.owns!=="function")return undefined;
    return ctx.on("user-questions/request",async(request,next)=>{
      try{return await next();}catch(error){
        if(error?.code!=="NO_PROVIDER" || !provider.owns(request))throw error;
        return await provider.ask(request);
      }
    });
  }
  if (!service) return undefined;
  try {
    return service.registerProvider(provider);
  } catch (error) {
    if (error?.code === "DUPLICATE_PROVIDER") return undefined;
    throw error;
  }
}
