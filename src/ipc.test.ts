import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDataDir = vi.hoisted(
  () =>
    `/tmp/nanoclaw-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: testDataDir,
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { processTaskIpc } from './ipc.js';
import {
  getTaskById,
  loadActiveTasks,
  saveActiveTasks,
  saveSession,
  getSession,
} from './store.js';
import type { ScheduledTask } from './types.js';

const deps = {
  sendMessage: vi.fn(async () => {}),
  getAvailableChats: vi.fn(() => []),
  writeGroupsSnapshot: vi.fn(),
};

describe('ipc', () => {
  beforeEach(() => {
    saveActiveTasks([]);
    vi.clearAllMocks();
  });

  it('schedules tasks for the trusted chat namespace', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-1',
        chatId: 'dc:other',
        prompt: 'run this',
        schedule_type: 'once',
        schedule_value: '2026-04-01T10:00:00.000Z',
        context_mode: 'isolated',
      },
      deps,
      'dc:trusted',
    );

    expect(loadActiveTasks()).toEqual([
      expect.objectContaining({
        id: 'task-1',
        chat_id: 'dc:trusted',
      }),
    ]);
  });

  it('ignores task mutations outside the trusted chat namespace', async () => {
    const tasks: ScheduledTask[] = [
      {
        id: 'task-a',
        chat_id: 'dc:trusted',
        prompt: 'trusted',
        schedule_type: 'once',
        schedule_value: '2026-04-01T10:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2026-04-01T10:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 'task-b',
        chat_id: 'dc:other',
        prompt: 'other',
        schedule_type: 'once',
        schedule_value: '2026-04-01T11:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2026-04-01T11:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ];
    saveActiveTasks(tasks);

    await processTaskIpc(
      {
        type: 'pause_task',
        taskId: 'task-b',
      },
      deps,
      'dc:trusted',
    );

    expect(getTaskById('task-b')?.status).toBe('active');
  });

  it('applies config updates to the trusted chat namespace', async () => {
    saveSession({
      chatId: 'dc:trusted',
      name: 'trusted',
      model: 'claude-sonnet-4-6',
    });
    saveSession({
      chatId: 'dc:other',
      name: 'other',
      model: 'claude-haiku-4-5',
    });

    await processTaskIpc(
      {
        type: 'update_config',
        chatId: 'dc:other',
        model: 'claude-opus-4-6',
      },
      deps,
      'dc:trusted',
    );

    expect(getSession('dc:trusted')?.model).toBe('claude-opus-4-6');
    expect(getSession('dc:other')?.model).toBe('claude-haiku-4-5');
  });
});
