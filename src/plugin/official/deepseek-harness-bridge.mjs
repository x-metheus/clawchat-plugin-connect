import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { registerClawChatApprovalPolicy } from "./deepseek-harness-tool-policy.mjs";
import { registerQuestionProviderWhenProfileReady } from "./deepseek-harness-question-provider.mjs";

const PROTOCOL_NAME = "clawchat-connect-dsh-bridge";
const PROTOCOL_MAJOR = 1;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 128;
const dshRequire = createRequire(process.argv[1]);
const [{ contentHasImage, createUserMessage }, { installModelSelection }, skillModule, presetModule] =
  await Promise.all([
    import(pathToFileURL(dshRequire.resolve("@deepseek-ai/dsh-llm")).href),
    import(pathToFileURL(dshRequire.resolve("@deepseek-ai/dsh-agent")).href),
    optionalDshImport("@deepseek-ai/dsh-skill"),
    optionalDshImport("@deepseek-ai/dsh-agent-presets"),
  ]);
const renderSkillContent = skillModule?.renderSkillContent;
const resolveSessionPreset = presetModule?.resolveSessionPreset;
const outputFd = Number(process.env.CONNECT_DSH_BRIDGE_FD_OUT ?? "3");
const inputFd = Number(process.env.CONNECT_DSH_BRIDGE_FD_IN ?? "4");

export const name = "clawchat-connect-deepseek-harness-bridge";
export const inject = ["agents", "agentLoop", "sessions", "sessionPersistence", "llm"];

export async function apply(ctx, config = {}) {
  const inputStream = createReadStream(null, { fd: inputFd, autoClose: true });
  const outputStream = createWriteStream(null, { fd: outputFd, autoClose: true });
  const lines = createInterface({ input: inputStream, crlfDelay: Number.POSITIVE_INFINITY });
  const handles = new Map();
  const pendingInteractions = new Map();
  let interactionSequence = 0;
  let disposed = false;
  let pendingRequests = 0;
  let writeTail = Promise.resolve();
  let requestTail = Promise.resolve();

  const send = (frame) => {
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
      throw bridgeError("frame-too-large", `Bridge frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    writeTail = writeTail.then(
      () =>
        new Promise((resolve, reject) => {
          outputStream.write(encoded, (error) => (error ? reject(error) : resolve()));
        }),
    );
    return writeTail;
  };

  const ownedSessionId = (agent) => {
    for (const [sessionId, handle] of handles) {
      if (handle.agent === agent) return sessionId;
    }
    return undefined;
  };

  const askConnect = async (sessionId, request, signal) => {
    const id = `dsh-interaction-${++interactionSequence}`;
    const response = new Promise((resolve, reject) => {
      const abort = () => {
        pendingInteractions.delete(id);
        reject(bridgeError("interaction-cancelled", "DSH interaction was cancelled"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      pendingInteractions.set(id, {
        sessionId,
        resolve(value) {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject(error) {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
    });
    await send({ type: "interaction", id, sessionId, request });
    return await response;
  };

  const approvalPolicy = registerClawChatApprovalPolicy(ctx, {
    owns: agent => Boolean(ownedSessionId(agent)),
    configPath: process.env.CLAWCHAT_CONNECT_CONFIG,
    ask: async (request, next) => {
    const sessionId = ownedSessionId(request.agent);
    if (!sessionId) return await next();
    const nativeDecision = await next();
    if (nativeDecision !== undefined && nativeDecision !== "unavailable") return nativeDecision;
    try {
      const response = await askConnect(
        sessionId,
        {
          kind: "approval",
          action: request.toolName.toLowerCase().includes("write") ? "file-change" : "command",
          title: `DeepSeek Harness requests ${request.toolName}`,
          description: request.reason ?? `Allow ${request.toolName} for this turn?`,
          options: [
            { id: "approve-once", label: "Approve once" },
            { id: "deny", label: "Deny" },
          ],
        },
        request.signal,
      );
      if (response?.kind !== "approval") return "unavailable";
      if (response.optionId === "approve-once") return "allowed-once";
      if (response.optionId === "cancel") return "cancelled";
      return "rejected";
    } catch {
      return request.signal?.aborted ? "cancelled" : "unavailable";
    }
    },
  });

  const questionRegistration = registerQuestionProviderWhenProfileReady(ctx, {
    owns(request) { return Boolean(ownedSessionId(request.agent)); },
    async ask(request) {
      const sessionId = ownedSessionId(request.agent);
      if (!sessionId) throw bridgeError("interaction-unavailable", "DSH question has no Connect-owned Agent");
      const response = await askConnect(
        sessionId,
        {
          kind: "user-input",
          title: "DeepSeek Harness needs your answer",
          description:
            request.questions.length === 1
              ? request.questions[0].question
              : `Answer ${request.questions.length} DeepSeek Harness questions.`,
          questions: request.questions.map((question) => ({
            id: question.id,
            header: question.header ?? question.id,
            prompt: question.question,
            secret: false,
            allowOther: true,
            options:
              question.options && question.options.length > 0
                ? question.options.map((option) => ({
                    id: option.label,
                    label: option.label,
                    ...(option.description ? { description: option.description } : {}),
                  }))
                : null,
          })),
          autoResolutionMs: null,
        },
        request.signal,
      );
      if (response?.kind !== "user-input") {
        throw bridgeError("interaction-unavailable", "Connect returned an incompatible question response");
      }
      return {
        answers: request.questions.map((question) => {
          const values = response.answers[question.id] ?? [];
          const labels = new Set(question.options?.map((option) => option.label) ?? []);
          const selected = values.filter((value) => labels.has(value));
          const custom = values.find((value) => !labels.has(value));
          return { id: question.id, selected, ...(custom ? { custom } : {}) };
        }),
      };
    },
  });

  const offEvents = ctx.on("session/event", (session, event) => {
    if (!handles.has(String(session.id))) return;
    approvalPolicy.observe(handles.get(String(session.id)).agent, event);
    void send({ type: "event", sessionId: String(session.id), event }).catch(() => {
      process.kill(process.pid, "SIGTERM");
    });
  });

  let workspaceRegistry;
  let agentDefaultModel;
  let attachments;
  let permissionPresets;
  let agentPresets;
  const resolveSelection = async (value) => {
    const provider = requestString(value, "provider");
    const model = requestString(value, "model");
    const reasoningEffort = optionalString(value.reasoningEffort);
    const resolved = await ctx.llm.resolveCallConfig({
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
    };
  };
  const createOwnedAgent = async ({ sessionId, cwd, selection, requestedPreset, resume }) => {
    let resolvedPreset;
    if (agentPresets) {
      resolvedPreset = (await agentPresets.resolve(requestedPreset)).id;
    } else if (requestedPreset && !resume) {
      throw bridgeError("unsupported", "Selected DSH Profile does not publish Agent Presets");
    }

    let modelSelection;
    let disposeModelSelection = () => {};
    const setup = async (agentCtx, nativeAgent) => {
      const agent = nativeAgent ?? agentCtx.agent;
      if (!agent) throw bridgeError("composition-failed", "DSH Agent setup has no scoped Agent");
      const logged = optionalObject(agent.session.requestHeader?.()?.config);
      const current =
        selection ??
        (logged && typeof logged.provider === "string" && typeof logged.model === "string"
          ? {
              provider: logged.provider,
              model: logged.model,
              ...(typeof logged.reasoningEffort === "string" ? { reasoningEffort: logged.reasoningEffort } : {}),
            }
          : agentDefaultModel?.currentSelection?.());
      modelSelection = agent.model && typeof agent.model.current==="function"
        ? {get current(){return agent.model.current();}}
        : {current,assembled:undefined};
      const dispose=agent.model?installModelSelection(agentCtx):installModelSelection(agentCtx,modelSelection);
      disposeModelSelection=typeof dispose==="function"?dispose:()=>{};
      if(agent.model && typeof agent.model.select==="function" && current)agent.model.select(current);
      try {
        if (agentPresets) await agentPresets.mount(agentCtx, resolvedPreset);
      } catch (error) {
        disposeModelSelection();
        disposeModelSelection = () => {};
        throw error;
      }
    };

    let nativeHandle;
    try {
      nativeHandle = resume
        ? await ctx.agents.resume({
            resumeSessionId: sessionId,
            ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
            setup,
          })
        : await ctx.agents.create({
            sessionId,
            meta: { cwd, ...(resolvedPreset ? { agentPreset: resolvedPreset } : {}) },
            ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
            setup,
          });
    } catch (error) {
      disposeModelSelection();
      throw error;
    }
    if (!modelSelection) {
      await nativeHandle.dispose();
      throw bridgeError("composition-failed", "DSH Agent setup did not install model selection");
    }
    return {
      agent: nativeHandle.agent,
      modelSelection,
      async dispose() {
        disposeModelSelection();
        await nativeHandle.dispose();
      },
    };
  };
  const hello = questionRegistration.ready.then(async (questions) => {
    if (disposed) return;
    workspaceRegistry = ctx.get("workspaceRegistry");
    agentDefaultModel = ctx.root.get("agentDefaultModel");
    attachments = ctx.root.get("attachments");
    permissionPresets = ctx.root.get("permissionPresets");
    agentPresets = ctx.root.get("agentPresets");
    await send({
      type: "hello",
      protocol: {
        name: PROTOCOL_NAME,
        major: PROTOCOL_MAJOR,
        build: requiredString(config.build, "Bridge build"),
      },
      home: requiredString(config.home, "DSH Home"),
      profile: optionalString(config.profile) ?? null,
      capabilities: {
        promptQueue: true,
        promptSteer: true,
        cancel: true,
        durableReceipt: true,
        history: true,
        approvals: Boolean(ctx.root.get("approval")),
        questions,
        models: true,
        presets: Boolean(agentPresets),
        permissionPresets: Boolean(permissionPresets),
        skills: Boolean(ctx.root.get("skills") && renderSkillContent),
        commands: Boolean(ctx.root.get("commands")),
        imageInput: Boolean(attachments),
        localProducedFilePresentation: false,
        portableArtifactOutput: false,
        archive: Boolean(workspaceRegistry),
        restore: false,
        delete: false,
        crossProcessSessionOwnership: false,
      },
    });
  });
  void hello.catch(() => {
    if (!disposed) process.kill(process.pid, "SIGTERM");
  });

  const methods = {
    async create(params) {
      const sessionId = requestString(params, "sessionId");
      const existing = handles.get(sessionId);
      if (existing) return { sessionId, header: existing.agent.session.header };
      const cwd = requestString(params, "cwd");
      const requestedSelection = optionalObject(params.model) ?? agentDefaultModel?.currentSelection?.();
      const selection = requestedSelection ? await resolveSelection(requestedSelection) : undefined;
      const permissionPreset = optionalString(params.permissionPreset);
      const handle = await createOwnedAgent({
        sessionId,
        cwd,
        selection,
        requestedPreset: optionalString(params.agentPreset),
        resume: false,
      });
      handles.set(String(handle.agent.id), handle);
      if (permissionPreset) {
        if (!permissionPresets) {
          await handle.dispose();
          handles.delete(String(handle.agent.id));
          throw bridgeError("unsupported", "Selected DSH Profile does not publish Permission Presets");
        }
        try {
          permissionPresets.set(handle.agent.session, permissionPreset);
          await ctx.sessions.flush(handle.agent.session);
        } catch (error) {
          await handle.dispose();
          handles.delete(String(handle.agent.id));
          throw error;
        }
      }
      await ctx.sessions.flush(handle.agent.session);
      return { sessionId: String(handle.agent.id), header: handle.agent.session.header };
    },

    async resume(params) {
      const sessionId = requestString(params, "sessionId");
      const existing = handles.get(sessionId);
      if (existing) return { sessionId, header: existing.agent.session.header };
      const inspection = await inspectPersistedSession(ctx.sessionPersistence,sessionId);
      const requestedPreset = resolveSessionPreset
        ? resolveSessionPreset({header:inspection.meta,events:inspection.events})
        : optionalString([...inspection.events].reverse().find(event=>event.type==="agent-preset/selected")?.data?.agentPreset) ?? optionalString(inspection.meta?.agentPreset);
      const handle = await createOwnedAgent({
        sessionId,
        selection: undefined,
        requestedPreset,
        resume: true,
      });
      handles.set(String(handle.agent.id), handle);
      return { sessionId: String(handle.agent.id), header: handle.agent.session.header };
    },

    async prompt(params) {
      const handle = ownedHandle(handles, requestString(params, "sessionId"));
      const inputId = requestString(params, "inputId");
      const text = requestString(params, "text", true);
      const images = requestImages(params);
      const imageRefs =
        images.length === 0
          ? []
          : await (async () => {
              if (!attachments) {
                throw bridgeError("unsupported-media", "Selected DSH Profile does not publish Attachments");
              }
              const selection = handle.modelSelection.current;
              if (!selection) {
                throw bridgeError("model-unavailable", "DSH image input requires an exact model selection");
              }
              const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model);
              if (!model.inputModalities?.includes("image")) {
                throw bridgeError(
                  "unsupported-media",
                  `DSH model "${selection.model}" does not accept image input`,
                );
              }
              const stored = await Promise.all(
                images.map(async (image) => ({
                  data: new Uint8Array(await readFile(image.path)),
                  mediaType: image.mediaType,
                  ...(image.name ? { name: image.name } : {}),
                })),
              );
              return await attachments.saveImages(stored);
            })();
      const skillName = optionalString(params.skillName);
      if (skillName) {
        const skills = ctx.root.get("skills");
        if (!skills || !renderSkillContent) {
          throw bridgeError("unsupported", "Selected DSH Profile does not publish Skills");
        }
        const skill = await skills.get(skillName, {
          cwd: handle.agent.session.header.cwd,
          scope: handle.agent,
        });
        if (!skill?.invocation.userInvocable) {
          throw bridgeError("skill-not-found", `DSH Skill is not user-invocable: ${skillName}`);
        }
        handle.agent.inject(
          createUserMessage({
            content: [{ type: "text", text: renderSkillContent(skill) }],
            source: { kind: "skill-invocation", name: skill.name, form: "instructions" },
          }),
        );
      }
      const message = createUserMessage({
        content: [
          { type: "text", text },
          ...imageRefs.map((attachment) => ({ type: "image", attachment })),
        ],
        source: { kind: "user", connectInputId: inputId,
          ...(['client','clawchat'].includes(params.inputOrigin) ? {connectInputOrigin:params.inputOrigin} : {}),
          ...(optionalString(params.clawchatTurnContext) ? {clawchatTurnContext:params.clawchatTurnContext} : {}),
        },
      });
      if (params.mode === "steer") handle.agent.steer(message);
      else handle.agent.followup(message);
      await ctx.sessions.flush(handle.agent.session);
      return { inputId, messageId: String(message.id) };
    },

    async cancel(params) {
      const handle = ownedHandle(handles, requestString(params, "sessionId"));
      handle.agent.cancel({ kind: "user" }, { keepInbox: true });
      await handle.agent.whenIdle();
      await ctx.sessions.flush(handle.agent.session);
      const terminal = sessionEvents(handle.agent.session)
        .reverse()
        .find((event) => event.type === "turn/end");
      return { reason: terminal?.data?.reason?.kind ?? null, idle: handle.agent.status === "idle" };
    },

    async models() {
      const defaultSelection = agentDefaultModel?.currentSelection?.();
      const providers = ctx.llm.listProviders();
      const groups = await Promise.all(
        providers.map(async (provider) => {
          const models = await ctx.llm.listModels(provider.id);
          return await Promise.all(
            models.map(async (model) => {
              let resolved;
              try {
                resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
              } catch {
                resolved = model;
              }
              return {
                provider: provider.id,
                id: model.id,
                name: model.name,
                ...(model.description ? { description: model.description } : {}),
                ...(defaultSelection?.provider === provider.id && defaultSelection.model === model.id
                  ? { isDefault: true }
                  : {}),
                ...(resolved.inputModalities ? { inputModalities: [...resolved.inputModalities] } : {}),
                ...(resolved.context?.contextWindow ? { contextWindow: resolved.context.contextWindow } : {}),
                ...(resolved.defaultMaxTokens ? { defaultMaxTokens: resolved.defaultMaxTokens } : {}),
                ...(attachments && resolved.inputModalities?.includes("image")
                  ? {
                      imageLimits: {
                        maxImageBytes: attachments.imageLimits.maxImageBytes,
                        maxImagesPerMessage: attachments.imageLimits.maxImagesPerMessage,
                        maxMessageImageBytes: attachments.imageLimits.maxMessageImageBytes,
                        mediaTypes: [...attachments.imageLimits.mediaTypes],
                      },
                    }
                  : {}),
                ...(resolved.reasoning
                  ? {
                      reasoning: {
                        efforts: resolved.reasoning.efforts.map((effort) => ({ ...effort })),
                        ...(resolved.reasoning.defaultEffort
                          ? { defaultEffort: resolved.reasoning.defaultEffort }
                          : {}),
                      },
                    }
                  : {}),
              };
            }),
          );
        }),
      );
      return groups.flat();
    },

    async selectModel(params) {
      const handle = ownedHandle(handles, requestString(params, "sessionId"));
      const selection = await resolveSelection(optionalObject(params.model));
      const hasImage =
        [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep].some((message) =>
          contentHasImage(message.content),
        ) || handle.agent.session.deriveMessages().some((message) => contentHasImage(message.content));
      if (hasImage) {
        const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model);
        if (!model.inputModalities?.includes("image")) {
          throw bridgeError(
            "model-unavailable",
            `DSH model "${selection.model}" does not accept this Session's image history`,
          );
        }
      }
      if(handle.agent.model && typeof handle.agent.model.select==="function")handle.agent.model.select(selection);
      else handle.modelSelection.current=selection;
      await ctx.sessions.flush(handle.agent.session);
      return { ...selection };
    },

    async presets() {
      const presets = ctx.root.get("agentPresets");
      if (!presets) throw bridgeError("unsupported", "Selected DSH Profile does not publish Agent Presets");
      return {
        defaultId: presets.defaultId,
        presets: (await presets.list()).map((preset) => ({
          id: preset.id,
          ...(preset.name ? { name: preset.name } : {}),
          ...(preset.description ? { description: preset.description } : {}),
          ...(preset.broken ? { broken: preset.broken } : {}),
        })),
      };
    },

    async permissionPresets() {
      if (!permissionPresets) {
        throw bridgeError("unsupported", "Selected DSH Profile does not publish Permission Presets");
      }
      return {
        defaultId: permissionPresets.defaultPreset,
        presets: permissionPresets.names.map((id) => {
          const option = permissionPresets.optionOf(id);
          return {
            id,
            name: option.name,
            ...(option.description ? { description: option.description } : {}),
          };
        }),
      };
    },

    async skills(params) {
      const skills = ctx.root.get("skills");
      if (!skills) throw bridgeError("unsupported", "Selected DSH Profile does not publish Skills");
      const cwd = requestString(params, "cwd");
      const sessionId = optionalString(params.sessionId);
      const handle = sessionId ? handles.get(sessionId) : undefined;
      const listed = await skills.list({ cwd, ...(handle ? { scope: handle.agent } : {}) });
      return listed.map((skill) => ({
        name: skill.name,
        description: skill.description,
        userInvocable: skill.invocation.userInvocable,
      }));
    },

    async commands(params) {
      const commands = ctx.root.get("commands");
      if (!commands) throw bridgeError("unsupported", "Selected DSH Profile does not publish Commands");
      const handle = ownedHandle(handles, requestString(params, "sessionId"));
      return commands.list(handle.agent).map((command) => ({
        name: command.name,
        description: command.description,
      }));
    },

    async command(params) {
      const commands = ctx.root.get("commands");
      if (!commands) throw bridgeError("unsupported", "Selected DSH Profile does not publish Commands");
      const handle = ownedHandle(handles, requestString(params, "sessionId"));
      const controller = new AbortController();
      const execution = await commands.execute(
        handle.agent,
        requestString(params, "line"),
        [],
        controller.signal,
      );
      if (!execution) throw bridgeError("command-not-found", "DSH Command is no longer available");
      await ctx.sessions.flush(handle.agent.session);
      return execution;
    },

    async discover() {
      const headers = await ctx.sessionPersistence.list();
      const archived = new Set(workspaceRegistry?.archivedSessionIds.map(String) ?? []);
      return await Promise.all(
        headers.map(async (snapshot) => {
          const header=snapshot.header??snapshot;
          let events = [];
          try {
            events = [...(await inspectPersistedSession(ctx.sessionPersistence,header.id)).events];
          } catch {
            // The header remains visible. History reads report the concrete corruption separately.
          }
          const titleEvent = [...events].reverse().find((event) => event.type === "session/title");
          const title = typeof titleEvent?.data?.title === "string" ? titleEvent.data.title : null;
          const updatedAt = events.length > 0 ? events[events.length - 1].time : header.createdAt;
          return {
            header,
            owned: handles.has(String(header.id)),
            archived: archived.has(String(header.id)),
            title,
            updatedAt,
          };
        }),
      );
    },

    async history(params) {
      const sessionId = requestString(params, "sessionId");
      const handle = handles.get(sessionId);
      if (handle) {
        return { header: handle.agent.session.header, events: sessionEvents(handle.agent.session) };
      }
      const inspection = await inspectPersistedSession(ctx.sessionPersistence,sessionId);
      return { header: inspection.meta, events: [...inspection.events] };
    },

    async reconcile(params) {
      const sessionId = requestString(params, "sessionId");
      const inputId = requestString(params, "inputId");
      const history = await methods.history({ sessionId });
      const event = history.events.find(
        (candidate) =>
          candidate.type === "user/message" &&
          candidate.data?.source?.kind === "user" &&
          candidate.data.source.connectInputId === inputId,
      );
      return event
        ? { outcome: "accepted", inputId, messageId: String(event.data.id), eventSeq: event.seq }
        : { outcome: "absent" };
    },


    async archive(params) {
      const sessionId = requestString(params, "sessionId");
      if (!workspaceRegistry) {
        throw bridgeError("unsupported", "Selected DSH Profile does not publish Workspace archive services");
      }
      if (workspaceRegistry.archivedSessionIds.map(String).includes(sessionId)) return { archived: true };
      const handle = handles.get(sessionId);
      if (handle?.agent.status !== "idle") throw bridgeError("conflict", "An active DSH Session cannot be archived");
      if (handle) {
        await handle.dispose();
        handles.delete(sessionId);
      }
      await workspaceRegistry.archiveSession(sessionId);
      return { archived: true };
    },

    async interactionResponse(params) {
      const id = requestString(params, "id");
      const sessionId = requestString(params, "sessionId");
      const response = optionalObject(params.response);
      if (!response) throw bridgeError("malformed-request", "interaction response must be an object");
      const pending = pendingInteractions.get(id);
      if (!pending || pending.sessionId !== sessionId) {
        throw bridgeError("interaction-not-found", `DSH interaction is no longer pending: ${id}`);
      }
      pendingInteractions.delete(id);
      pending.resolve(response);
      return { accepted: true };
    },

    async shutdown() {
      const error = bridgeError("interaction-cancelled", "DSH Bridge is shutting down");
      for (const pending of pendingInteractions.values()) pending.reject(error);
      pendingInteractions.clear();
      const owned = [...handles.values()];
      handles.clear();
      await Promise.all(owned.map(async (handle) => await handle.dispose()));
      return { disposed: true };
    },
  };

  const processRequest = async (request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw bridgeError("malformed-request", "Bridge request must be an object");
    }
    if (request.type !== "request" || typeof request.id !== "string" || typeof request.method !== "string") {
      throw bridgeError("malformed-request", "Bridge request envelope is malformed");
    }
    const method = methods[request.method];
    if (!method) throw bridgeError("method-not-found", `Unsupported Bridge method: ${request.method}`);
    const params = optionalObject(request.params) ?? {};
    const result = await method(params);
    await send({ type: "response", id: request.id, ok: true, result });
    if (request.method === "shutdown") {
      lines.close();
      inputStream.destroy();
      await writeTail;
      setImmediate(() => process.kill(process.pid, "SIGTERM"));
    }
  };

  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      process.kill(process.pid, "SIGTERM");
      return;
    }
    if (pendingRequests >= MAX_PENDING_REQUESTS) {
      process.kill(process.pid, "SIGTERM");
      return;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.kill(process.pid, "SIGTERM");
      return;
    }
    pendingRequests += 1;
    const executeRequest = async () =>
      await processRequest(request)
        .catch(async (error) => {
          const id = request && typeof request === "object" && typeof request.id === "string" ? request.id : "";
          if (!id) {
            process.kill(process.pid, "SIGTERM");
            return;
          }
          await send({
            type: "response",
            id,
            ok: false,
            error: {
              code: typeof error?.code === "string" ? error.code : "internal-error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        })
        .finally(() => {
          pendingRequests -= 1;
        });
    if (request?.method === "interactionResponse" || request?.method === "cancel") {
      void executeRequest();
    } else {
      requestTail = requestTail.then(executeRequest);
    }
  });

  return async () => {
    if (disposed) return;
    disposed = true;
    offEvents();
    approvalPolicy.dispose();
    await questionRegistration.dispose();
    await hello.catch(() => undefined);
    const interactionError = bridgeError("interaction-cancelled", "DSH Bridge disposed");
    for (const pending of pendingInteractions.values()) pending.reject(interactionError);
    pendingInteractions.clear();
    lines.close();
    inputStream.destroy();
    const owned = [...handles.values()];
    handles.clear();
    await Promise.all(owned.map(async (handle) => await handle.dispose()));
    await requestTail.catch(() => undefined);
    await writeTail.catch(() => undefined);
    await new Promise((resolve) => outputStream.end(resolve));
  };
}
function sessionEvents(session){
  if(typeof session.eventAt!=="function")return [...session.events];
  const events=[];
  for(let seq=0;seq<=session.seq;seq++){const event=session.eventAt(seq);if(event!==undefined)events.push(event);}
  return events;
}
async function inspectPersistedSession(persistence,sessionId){
  if(typeof persistence.inspect==="function")return await persistence.inspect(sessionId);
  const handle=await persistence.open(sessionId,"read");
  try {const result=await handle.read(0);return {meta:handle.header,events:result.events};}
  finally {await handle.close();}
}
async function optionalDshImport(name) {
  try {
    return await import(pathToFileURL(dshRequire.resolve(name)).href);
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}



function ownedHandle(handles, sessionId) {
  const handle = handles.get(sessionId);
  if (!handle) throw bridgeError("session-not-owned", `DSH Session is not owned by this process: ${sessionId}`);

  return handle;
}

function requestString(value, key, allowEmpty = false) {
  const result = value?.[key];
  if (typeof result !== "string" || (!allowEmpty && result.trim() === "")) {
    throw bridgeError("malformed-request", `${key} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  }
  return result;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function requestImages(params) {
  if (params?.images === undefined) return [];
  if (!Array.isArray(params.images)) throw bridgeError("malformed-request", "images must be an array");
  return params.images.map((value) => {
    const image = optionalObject(value);
    if (!image) throw bridgeError("malformed-request", "each image must be an object");
    const name = optionalString(image.name);
    return {
      path: requestString(image, "path"),
      mediaType: requestString(image, "mediaType"),
      ...(name ? { name } : {}),
    };
  });
}

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}
