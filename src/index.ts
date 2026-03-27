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
  listSessions,
  readRecentEvents,
  saveSession,
} from './store.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, ChatSession, NewMessage } from './types.js';

export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, ChatSession> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadChatSessions(): void {
  sessions = Object.fromEntries(
    listSessions().map((session) => [session.chatId, session]),
  );
}

export function getAvailableChats(): import('./container-runner.js').AvailableChat[] {
  return Object.values(sessions)
    .sort((a, b) =>
      (a.name || a.chatId).localeCompare(b.name || b.chatId),
    )
    .map((session) => ({
      chatId: session.chatId,
      name: session.name || session.chatId,
      lastActivity: session.resumeAt || '',
      isRegistered: true,
    }));
}

export function _setSessions(
  nextSessions: Record<string, ChatSession>,
): void {
  sessions = nextSessions;
}

function saveChatSession(session: ChatSession): void {
  saveSession(session);
  sessions[session.chatId] = session;
}

async function runAgent(
  session: ChatSession,
  prompt: string,
  chatId: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const tasks = getAllTasks();
  writeTasksSnapshot(
    tasks.map((task) => ({
      id: task.id,
      chatId: task.chat_id,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );
  writeGroupsSnapshot(getAvailableChats());

  try {
    const output = await runContainerAgent(
      session,
      {
        prompt,
        sessionId: session.sessionId,
        chatId,
        model: session.model || 'claude-sonnet-4-6',
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => queue.registerProcess(chatId, proc, containerName),
      async (streamed) => {
        if (streamed.newSessionId) {
          saveChatSession({
            ...session,
            sessionId: streamed.newSessionId,
          });
        }
        await onOutput?.(streamed);
      },
    );

    if (output.newSessionId) {
      saveChatSession({
        ...session,
        sessionId: output.newSessionId,
      });
    }

    return output.status === 'success' ? 'success' : 'error';
  } catch (err) {
    logger.error({ err, chatId }, 'Agent error');
    return 'error';
  }
}

async function processChatMessages(chatId: string): Promise<boolean> {
  const session = sessions[chatId];
  if (!session) return true;

  const channel = channels.find((entry) => entry.ownsChatId(chatId));
  if (!channel) return true;

  const events = readRecentEvents(chatId, 200).filter(
    (event) =>
      (!session.resumeAt || event.timestamp > session.resumeAt) &&
      event.content.trim().length > 0,
  );

  if (events.length === 0) return true;

  const prompt = formatMessages(events, TIMEZONE);
  let hadError = false;

  await channel.setTyping?.(chatId, true);

  const status = await runAgent(session, prompt, chatId, async (result) => {
    if (result.result) {
      const text = formatOutbound(result.result);
      if (text) {
        await channel.sendMessage(chatId, text);
        appendEvent(chatId, {
          id: `assistant-${Date.now()}`,
          chat_id: chatId,
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
      queue.notifyIdle(chatId);
    }
    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatId, false);

  if (status === 'success' && !hadError) {
    saveChatSession({
      ...session,
      resumeAt: events[events.length - 1].timestamp,
    });
    return true;
  }

  return false;
}

async function compactChat(chatId: string): Promise<void> {
  const session = sessions[chatId];
  if (!session) return;
  const events = readRecentEvents(chatId, 50);
  const summary = events
    .slice(-10)
    .map((event) => `${event.sender_name}: ${event.content}`)
    .join('\n')
    .slice(0, 4000);

  appendEvent(chatId, {
    id: `summary-${Date.now()}`,
    chat_id: chatId,
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
  loadChatSessions();

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
    onMessage: (chatId: string, message: NewMessage) => {
      appendEvent(chatId, { ...message, type: 'message' });
      queue.enqueueMessageCheck(chatId);
    },
    getChatSession: (chatId) => sessions[chatId],
    resetSession: (chatId) => {
      const session = sessions[chatId];
      if (!session) return;
      saveChatSession({
        ...session,
        sessionId: undefined,
        resumeAt: undefined,
      });
    },
    updateModel: (chatId, model) => {
      const session = sessions[chatId];
      if (!session) return;
      saveChatSession({ ...session, model });
    },
    compact: (chatId) => compactChat(chatId),
  });

  if (!discord) {
    logger.fatal('Discord channel unavailable');
    process.exit(1);
  }
  channels.push(discord);
  await discord.connect();

  startSchedulerLoop({
    queue,
    onProcess: (chatId, proc, containerName) =>
      queue.registerProcess(chatId, proc, containerName),
    sendMessage: async (chatId, rawText) => {
      const channel = channels.find((entry) => entry.ownsChatId(chatId));
      if (!channel) return;
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(chatId, text);
    },
  });

  startIpcWatcher({
    sendMessage: async (chatId, text) => {
      const channel = channels.find((entry) => entry.ownsChatId(chatId));
      if (!channel) throw new Error(`No channel for chat ID: ${chatId}`);
      await channel.sendMessage(chatId, text);
    },
    getAvailableChats,
    writeGroupsSnapshot: (chats) => writeGroupsSnapshot(chats),
  });

  queue.setProcessMessagesFn(processChatMessages);
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
