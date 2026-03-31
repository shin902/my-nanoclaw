import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';
import { safeChatId } from './store.js';

interface QueuedTask {
  id: string;
  chatId: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((chatId: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(chatId: string): GroupState {
    let state = this.groups.get(chatId);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        retryCount: 0,
        retryTimer: null,
      };
      this.groups.set(chatId, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (chatId: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(chatId: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatId);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ chatId }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(chatId)) {
        this.waitingGroups.push(chatId);
      }
      logger.debug(
        { chatId, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(chatId, 'messages').catch((err) =>
      logger.error({ chatId, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(chatId: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatId);

    // 重複エンキューを防止: 実行中および保留中のタスクの両方を確認
    if (state.runningTaskId === taskId) {
      logger.debug({ chatId, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ chatId, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, chatId, fn });
      if (state.idleWaiting) {
        this.closeStdin(chatId);
      }
      logger.debug({ chatId, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, chatId, fn });
      if (!this.waitingGroups.includes(chatId)) {
        this.waitingGroups.push(chatId);
      }
      logger.debug(
        { chatId, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // 即座に実行
    this.runTask(chatId, { id: taskId, chatId, fn }).catch((err) =>
      logger.error({ chatId, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    chatId: string,
    proc: ChildProcess,
    containerName: string,
  ): void {
    const state = this.getGroup(chatId);
    state.process = proc;
    state.containerName = containerName;
  }

  /**
   * コンテナをアイドル待機状態（作業が終了し、IPC 入力を待っている状態）としてマークします。
   * 保留中のタスクがある場合は、即座にアイドルコンテナを終了させます。
   */
  notifyIdle(chatId: string): void {
    const state = this.getGroup(chatId);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(chatId);
    }
  }

  /**
   * IPC ファイルを介して、アクティブなコンテナに追撃メッセージを送信します。
   * メッセージが書き込まれた場合は true、アクティブなコンテナがない場合は false を返します。
   */
  sendMessage(chatId: string, text: string): boolean {
    const state = this.getGroup(chatId);
    if (!state.active || state.isTaskContainer) return false;
    state.idleWaiting = false; // エージェントが作業を受け取ろうとしているため、アイドル状態ではなくなる

    const inputDir = path.join(DATA_DIR, 'ipc', 'input', safeChatId(chatId));
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ type: 'message', chatId, text }),
      );
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 終了センチネルを書き込むことで、アクティブなコンテナに終了の合図を送ります。
   */
  closeStdin(chatId: string): void {
    const state = this.getGroup(chatId);
    if (!state.active) return;

    const inputDir = path.join(DATA_DIR, 'ipc', 'input', safeChatId(chatId));
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // 無視
    }
  }

  private async runForGroup(
    chatId: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(chatId);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { chatId, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(chatId);
        if (success) {
          this.clearRetryTimer(state);
          state.retryCount = 0;
        } else {
          this.scheduleRetry(chatId, state);
        }
      }
    } catch (err) {
      logger.error({ chatId, err }, 'Error processing messages for group');
      this.scheduleRetry(chatId, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(chatId);
    }
  }

  private async runTask(chatId: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(chatId);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { chatId, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ chatId, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(chatId);
    }
  }

  private scheduleRetry(chatId: string, state: GroupState): void {
    this.clearRetryTimer(state);
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { chatId, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { chatId, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(chatId);
      }
    }, delayMs);
    state.retryTimer.unref?.();
  }

  private clearRetryTimer(state: GroupState): void {
    if (!state.retryTimer) return;
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  private drainGroup(chatId: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatId);

    // タスクを優先（メッセージのように SQLite から再取得されないため）
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(chatId, task).catch((err) =>
        logger.error(
          { chatId, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // 次に保留中のメッセージ
    if (state.pendingMessages) {
      this.runForGroup(chatId, 'drain').catch((err) =>
        logger.error({ chatId, err }, 'Unhandled error in runForGroup (drain)'),
      );
      return;
    }

    // このグループに保留中のものはない。他のグループがスロットを待っていないか確認
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextChatId = this.waitingGroups.shift()!;
      const state = this.getGroup(nextChatId);

      // メッセージよりタスクを優先
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextChatId, task).catch((err) =>
          logger.error(
            { chatId: nextChatId, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextChatId, 'drain').catch((err) =>
          logger.error(
            { chatId: nextChatId, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // いずれも保留されていない場合は、このグループをスキップ
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // アクティブなコンテナの数をカウントするが、強制終了はしない。
    // アイドルタイムアウトまたはコンテナタイムアウトにより、自発的に終了する。
    // --rm フラグにより、終了時にクリーンアップされる。
    // これにより、WhatsApp の再接続による再起動が、作業中のエージェントを殺すのを防ぐ。
    const activeContainers: string[] = [];
    for (const [chatId, state] of this.groups) {
      this.clearRetryTimer(state);
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
