import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  appendTaskLog,
  getAllTasks,
  getDueTasks,
  getSession,
  getTaskById,
  updateTask,
} from './store.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    const scheduledAt = new Date(task.next_run!).getTime();
    if (scheduledAt > now) {
      return task.next_run;
    }
    let next = scheduledAt + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  queue: GroupQueue;
  onProcess: (
    chatId: string,
    proc: ChildProcess,
    containerName: string,
  ) => void;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  logger.info(
    { taskId: task.id, chatId: task.chat_id },
    'Running scheduled task',
  );

  const session = getSession(task.chat_id);
  if (!session) {
    logger.error(
      { taskId: task.id, chatId: task.chat_id },
      'Session not found for task',
    );
    updateTask(task.id, { status: 'paused' });
    appendTaskLog({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Session not found: ${task.chat_id}`,
    });
    return;
  }

  const tasks = getAllTasks();
  writeTasksSnapshot(
    tasks.map((t) => ({
      id: t.id,
      chatId: t.chat_id,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    task.chat_id,
  );

  let result: string | null = null;
  let error: string | null = null;
  const sessionId =
    task.context_mode === 'group' ? session.sessionId : undefined;

  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_id);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      session,
      {
        prompt: task.prompt,
        sessionId,
        chatId: task.chat_id,
        model: session.model || 'claude-sonnet-4-6',
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_id, proc, containerName),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_id, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_id);
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  appendTaskLog({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTask(task.id, {
    next_run: nextRun,
    last_run: new Date().toISOString(),
    last_result: resultSummary,
    status: nextRun === null ? 'completed' : task.status,
  });
}

let schedulerRunning = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_id, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    schedulerTimer = setTimeout(loop, SCHEDULER_POLL_INTERVAL);
    schedulerTimer.unref?.();
  };

  loop();
}

export function _resetSchedulerLoopForTests(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerRunning = false;
}
