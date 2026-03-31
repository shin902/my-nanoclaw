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
import { loadActiveTasks, saveActiveTasks } from './store.js';

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
});
