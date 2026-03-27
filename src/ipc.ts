import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableChat } from './container-runner.js';
import { logger } from './logger.js';
import {
  deleteTask,
  getSession,
  getTaskById,
  saveSession,
  updateTask,
  upsertTask,
} from './store.js';
import { ScheduledTask } from './types.js';

export interface IpcDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  getAvailableChats: () => AvailableChat[];
  writeGroupsSnapshot: (availableChats: AvailableChat[]) => void;
}

let ipcWatcherRunning = false;

function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (Number.isNaN(ms) || ms <= 0) {
      throw new Error(`Invalid interval: ${scheduleValue}`);
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const at = new Date(scheduleValue);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`Invalid timestamp: ${scheduleValue}`);
  }
  return at.toISOString();
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    chatId?: string;
    targetChatId?: string;
    text?: string;
    model?: string;
    sessionId?: string | null;
    resumeAt?: string | null;
  },
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'send_message':
      if (data.chatId && data.text) {
        await deps.sendMessage(data.chatId, data.text);
      }
      break;

    case 'update_config': {
      if (!data.chatId) break;
      const session = getSession(data.chatId);
      if (!session) break;
      saveSession({
        ...session,
        model: data.model ?? session.model,
        sessionId:
          data.sessionId === null
            ? undefined
            : (data.sessionId ?? session.sessionId),
        resumeAt:
          data.resumeAt === null
            ? undefined
            : (data.resumeAt ?? session.resumeAt),
      });
      deps.writeGroupsSnapshot(deps.getAvailableChats());
      break;
    }

    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetChatId
      ) {
        const task: ScheduledTask = {
          id:
            data.taskId ||
            `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_id: data.targetChatId,
          prompt: data.prompt,
          schedule_type: data.schedule_type as 'cron' | 'interval' | 'once',
          schedule_value: data.schedule_value,
          context_mode: data.context_mode === 'group' ? 'group' : 'isolated',
          next_run: computeNextRun(
            data.schedule_type as 'cron' | 'interval' | 'once',
            data.schedule_value,
          ),
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: new Date().toISOString(),
        };
        upsertTask(task);
      }
      break;

    case 'pause_task':
      if (data.taskId) updateTask(data.taskId, { status: 'paused' });
      break;

    case 'resume_task':
      if (data.taskId) updateTask(data.taskId, { status: 'active' });
      break;

    case 'cancel_task':
      if (data.taskId) deleteTask(data.taskId);
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) break;

        const nextScheduleType =
          (data.schedule_type as ScheduledTask['schedule_type'] | undefined) ||
          task.schedule_type;
        const nextScheduleValue = data.schedule_value || task.schedule_value;

        const updates: Partial<ScheduledTask> = {};

        if (typeof data.prompt === 'string') {
          updates.prompt = data.prompt;
        }

        if (data.schedule_type) {
          updates.schedule_type =
            data.schedule_type as ScheduledTask['schedule_type'];
        }

        if (data.schedule_value) {
          updates.schedule_value = data.schedule_value;
        }

        if (data.context_mode === 'group' || data.context_mode === 'isolated') {
          updates.context_mode = data.context_mode;
        }

        if (data.schedule_type || data.schedule_value) {
          updates.next_run = computeNextRun(
            nextScheduleType,
            nextScheduleValue,
          );
        }

        updateTask(data.taskId, updates);
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const messagesDir = path.join(ipcBaseDir, 'messages');
  const tasksDir = path.join(ipcBaseDir, 'tasks');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const processIpcFiles = async () => {
    for (const dirPath of [messagesDir, tasksDir]) {
      if (!fs.existsSync(dirPath)) continue;

      for (const file of fs
        .readdirSync(dirPath)
        .filter((name) => name.endsWith('.json'))) {
        const filePath = path.join(dirPath, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (
            dirPath === messagesDir &&
            data.type === 'message' &&
            data.chatId &&
            data.text
          ) {
            await deps.sendMessage(data.chatId, data.text);
          } else {
            await processTaskIpc(data, deps);
          }
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ filePath, err }, 'Error processing IPC file');
          try {
            const errorsDir = path.join(dirPath, 'errors');
            fs.mkdirSync(errorsDir, { recursive: true });
            const errorPath = path.join(errorsDir, file);
            fs.renameSync(filePath, errorPath);
            logger.info(
              { filePath, errorPath },
              'Moved failed IPC file to errors directory',
            );
          } catch (moveErr) {
            logger.error(
              { filePath, moveErr },
              'Failed to move bad IPC file, deleting instead',
            );
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
            } catch (unlinkErr) {
              logger.error(
                { filePath, unlinkErr },
                'Failed to delete bad IPC file after move failure',
              );
            }
          }
        }
      }
    }

    const timer = setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
    timer.unref?.();
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}
