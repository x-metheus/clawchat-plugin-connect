// Compiled inside the pinned Connect source tree as platform/entry.ts.
import { createClawChatApiClient } from '../src/clawchat/api-client';
import { loadConfig } from '../src/config';
import { createStateStore } from '../src/persistence/state';
import { WorkspaceCatalog } from '../src/workspaces/workspaces';
import { runConnectCli } from '../src/service/cli';

if (!['__clawnest-state','__clawnest-owner'].includes(process.argv[2] ?? '')) {
  process.exitCode = await runConnectCli(process.argv.slice(2));
} else {
  const config = await loadConfig(process.env.CLAWCHAT_CONNECT_CONFIG);
  const store = createStateStore({ dbPath: config.stateDbPath });
  try {
    const activation = await store.getActivation('dsh');
    if(process.argv[2]==='__clawnest-owner'){
      if(!activation?.ownerUserId||!activation.accessToken)throw new Error('ClawChat owner is not activated');
      const api=createClawChatApiClient({baseUrl:config.baseUrl,deviceId:(await store.getDeviceId())!,token:activation.accessToken});
      const owner=await api.getAgentOwnerProfile();
      if(owner.id!==activation.ownerUserId)throw new Error('ClawChat owner identity mismatch');
      console.log(JSON.stringify(owner));
    } else {
    if (activation && process.argv.includes('--prepare-workspace')) {
      const existing = await store.getCurrentRuntimeSession(activation.conversationId!, 'dsh');
      const intent = await store.getSessionIntent(activation.conversationId!, 'dsh');
      if (!existing && !intent) {
        const workspace = await new WorkspaceCatalog(store).add('dsh', `${process.env.HOME}/dsh`);
        await store.setSessionIntent({chatId:activation.conversationId!,agentId:'dsh',workspaceRef:workspace.workspaceRef,name:null,mode:null,model:null,reasoningEffort:null,sessionOptions:{}});
      }
    }
    const status = await store.getRuntimeStatus('dsh');
    console.log(JSON.stringify({userId:activation?.userId??null,ownerId:activation?.ownerUserId??null,conversationId:activation?.conversationId??null,connected:status?.websocketConnected===true,available:status?.runtimeAvailability==='available',updatedAt:status?.updatedAt??null,running:status?.globalRunning??0,queued:status?.globalQueued??0}));
    }
  } finally { await store.close(); }
}
