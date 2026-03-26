import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { logger } from './logger.js';
import {
  deleteTask,
  getTaskById,
  loadGroupConfig,
  saveGroupConfig,
  updateTask,
  upsertTask,
} from './store.js';
import { ScheduledTask } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    availableGroups: AvailableGroup[],
  ) => void;
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
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    text?: string;
    model?: string;
    sessionId?: string | null;
    resumeAt?: string | null;
  },
  sourceGroup: string,
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'send_message':
      if (data.chatJid && data.text) {
        if (data.chatJid !== sourceGroup) {
          logger.warn(
            `Unauthorized send_message attempt from group "${sourceGroup}" to "${data.chatJid}"`,
          );
          break;
        }
        await deps.sendMessage(data.chatJid, data.text);
      }
      break;

    case 'update_config':
      if (!data.groupFolder) break;
      const config = loadGroupConfig(data.groupFolder);
      if (!config) break;
      saveGroupConfig(data.groupFolder, {
        ...config,
        model: data.model ?? config.model,
        sessionId:
          data.sessionId === null
            ? undefined
            : (data.sessionId ?? config.sessionId),
        resumeAt:
          data.resumeAt === null
            ? undefined
            : (data.resumeAt ?? config.resumeAt),
      });
      deps.writeGroupsSnapshot(sourceGroup, deps.getAvailableGroups());
      break;

    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid &&
        data.groupFolder
      ) {
        const task: ScheduledTask = {
          id:
            data.taskId ||
            `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          group_folder: data.groupFolder,
          chat_jid: data.targetJid,
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
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    const groupFolders = fs.existsSync(ipcBaseDir)
      ? fs
          .readdirSync(ipcBaseDir)
          .filter((entry) =>
            fs.statSync(path.join(ipcBaseDir, entry)).isDirectory(),
          )
      : [];

    for (const sourceGroup of groupFolders) {
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

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
              data.chatJid &&
              data.text
            ) {
              await deps.sendMessage(data.chatJid, data.text);
            } else {
              await processTaskIpc(data, sourceGroup, deps);
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
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}
