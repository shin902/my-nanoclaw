import { ASSISTANT_NAME, CREDENTIAL_PROXY_PORT, TIMEZONE } from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { createDiscordChannel } from './channels/discord.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { formatMessages, formatOutbound } from './router.js';
import {
  appendEvent,
  getAllTasks,
  listRegisteredGroups,
  loadGroupConfig,
  readRecentEvents,
  saveGroupConfig,
} from './store.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, StoredGroupConfig } from './types.js';

export { escapeXml, formatMessages } from './router.js';

let registeredGroups: Record<string, StoredGroupConfig> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadRegisteredGroups(): void {
  registeredGroups = Object.fromEntries(
    listRegisteredGroups().map((group) => [group.jid, group]),
  );
}

export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  return Object.values(registeredGroups)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      jid: group.jid,
      name: group.name,
      lastActivity: group.resumeAt || group.added_at,
      isRegistered: true,
    }));
}

export function _setRegisteredGroups(
  groups: Record<string, StoredGroupConfig>,
): void {
  registeredGroups = groups;
}

function saveRegisteredGroup(group: StoredGroupConfig): void {
  saveGroupConfig(group.folder, group);
  registeredGroups[group.jid] = group;
}

async function runAgent(
  group: StoredGroupConfig,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );
  writeGroupsSnapshot(group.folder, getAvailableGroups());

  try {
    const output = await runContainerAgent(
      {
        name: group.name,
        folder: group.folder,
        trigger: '',
        added_at: group.added_at,
        containerConfig: group.containerConfig,
      },
      {
        prompt,
        sessionId: group.sessionId,
        groupFolder: group.folder,
        chatJid,
        model: group.model,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      async (streamed) => {
        if (streamed.newSessionId) {
          saveRegisteredGroup({
            ...group,
            sessionId: streamed.newSessionId,
          });
        }
        await onOutput?.(streamed);
      },
    );

    if (output.newSessionId) {
      saveRegisteredGroup({
        ...group,
        sessionId: output.newSessionId,
      });
    }

    return output.status === 'success' ? 'success' : 'error';
  } catch (err) {
    logger.error({ err, chatJid }, 'Agent error');
    return 'error';
  }
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = channels.find((entry) => entry.ownsJid(chatJid));
  if (!channel) return true;

  const events = readRecentEvents(group.folder, 200).filter(
    (event) =>
      (!group.resumeAt || event.timestamp > group.resumeAt) &&
      event.content.trim().length > 0,
  );

  if (events.length === 0) return true;

  const prompt = formatMessages(events, TIMEZONE);
  let hadError = false;

  await channel.setTyping?.(chatJid, true);

  const status = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const text = formatOutbound(result.result);
      if (text) {
        await channel.sendMessage(chatJid, text);
        appendEvent(group.folder, {
          id: `assistant-${Date.now()}`,
          chat_jid: chatJid,
          sender: ASSISTANT_NAME,
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          type: 'message',
        });
      }
    }
    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }
    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);

  if (status === 'success' && !hadError) {
    saveRegisteredGroup({
      ...group,
      resumeAt: events[events.length - 1].timestamp,
    });
    return true;
  }

  return false;
}

async function compactGroup(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;
  const events = readRecentEvents(group.folder, 50);
  const summary = events
    .slice(-10)
    .map((event) => `${event.sender_name}: ${event.content}`)
    .join('\n')
    .slice(0, 4000);

  appendEvent(group.folder, {
    id: `summary-${Date.now()}`,
    chat_jid: chatJid,
    sender: ASSISTANT_NAME,
    sender_name: ASSISTANT_NAME,
    content: summary,
    summary,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    type: 'summary',
  });
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  loadRegisteredGroups();

  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const channel of channels) await channel.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const discord = createDiscordChannel({
    onMessage: (chatJid: string, message: NewMessage, group) => {
      appendEvent(group.folder, { ...message, type: 'message' });
      queue.enqueueMessageCheck(chatJid);
    },
    getGroupConfig: (chatJid) => registeredGroups[chatJid],
    resetSession: (chatJid) => {
      const group = registeredGroups[chatJid];
      if (!group) return;
      saveRegisteredGroup({
        ...group,
        sessionId: undefined,
        resumeAt: undefined,
      });
    },
    updateModel: (chatJid, model) => {
      const group = registeredGroups[chatJid];
      if (!group) return;
      saveRegisteredGroup({ ...group, model });
    },
    compact: (chatJid) => compactGroup(chatJid),
  });

  if (!discord) {
    logger.fatal('Discord channel unavailable');
    process.exit(1);
  }
  channels.push(discord);
  await discord.connect();

  startSchedulerLoop({
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = channels.find((entry) => entry.ownsJid(jid));
      if (!channel) return;
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });

  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = channels.find((entry) => entry.ownsJid(jid));
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(jid, text);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (groupFolder, groups) =>
      writeGroupsSnapshot(groupFolder, groups),
  });

  queue.setProcessMessagesFn(processGroupMessages);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
