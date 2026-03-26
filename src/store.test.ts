import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testDataDir = vi.hoisted(
  () =>
    `/tmp/nanoclaw-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

vi.mock('./config.js', () => ({
  DATA_DIR: testDataDir,
}));

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import {
  _internals,
  appendEvent,
  appendTaskLog,
  listRegisteredGroups,
  loadActiveTasks,
  loadGroupConfig,
  readRecentEvents,
  readTodayEvents,
  saveActiveTasks,
  saveGroupConfig,
} from './store.js';
import type { GroupEvent, ScheduledTask, StoredGroupConfig } from './types.js';

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
}

describe('store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('appends and reads events in chronological order for today', () => {
    const eventA: GroupEvent = {
      id: '1',
      chat_jid: 'dc:1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2026-03-20T00:00:01.000Z',
    };
    const eventB: GroupEvent = {
      ...eventA,
      id: '2',
      content: 'second',
      timestamp: '2026-03-20T00:00:02.000Z',
    };

    vi.setSystemTime(new Date('2026-03-20T09:00:00.000Z'));
    appendEvent('group-one', eventB);
    appendEvent('group-one', eventA);

    expect(readTodayEvents('group-one').map((event) => event.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('reads recent events across today and yesterday and applies limit', () => {
    vi.setSystemTime(new Date('2026-03-20T09:00:00.000Z'));

    const groupDir = path.join(_internals.GROUPS_DATA_DIR, 'group-one');
    writeJsonl(path.join(groupDir, '2026-03-19.jsonl'), [
      {
        id: 'a',
        chat_jid: 'dc:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'yesterday',
        timestamp: '2026-03-19T23:59:59.000Z',
      },
    ]);
    writeJsonl(path.join(groupDir, '2026-03-20.jsonl'), [
      {
        id: 'b',
        chat_jid: 'dc:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'today-1',
        timestamp: '2026-03-20T00:00:01.000Z',
      },
      {
        id: 'c',
        chat_jid: 'dc:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'today-2',
        timestamp: '2026-03-20T00:00:02.000Z',
      },
    ]);

    expect(readRecentEvents('group-one', 2).map((event) => event.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('saves and loads group config atomically', () => {
    const config: StoredGroupConfig = {
      jid: 'dc:1',
      name: 'general',
      folder: 'general',
      model: 'claude-sonnet-4-6',
      provider: 'claude',
      sessionId: 'session-123',
      added_at: '2026-03-20T00:00:00.000Z',
      containerConfig: { timeout: 1234 },
    };

    saveGroupConfig('general', config);

    expect(loadGroupConfig('general')).toEqual(config);
    expect(fs.existsSync(`${_internals.groupConfigPath('general')}.tmp`)).toBe(
      false,
    );
  });

  it('lists only registered groups with config files', () => {
    saveGroupConfig('group-a', {
      jid: 'dc:1',
      name: 'group-a',
      folder: 'group-a',
      model: 'claude-sonnet-4-6',
      provider: 'claude',
      added_at: '2026-03-20T00:00:00.000Z',
    });
    fs.mkdirSync(path.join(_internals.GROUPS_DATA_DIR, 'group-b'), {
      recursive: true,
    });

    expect(listRegisteredGroups()).toEqual([
      expect.objectContaining({ jid: 'dc:1', folder: 'group-a' }),
    ]);
  });

  it('loads and saves active tasks', () => {
    const tasks: ScheduledTask[] = [
      {
        id: 'task-1',
        group_folder: 'group-a',
        chat_jid: 'dc:1',
        prompt: 'hello',
        schedule_type: 'once',
        schedule_value: '2026-03-20T01:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2026-03-20T01:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-03-20T00:00:00.000Z',
      },
    ];

    saveActiveTasks(tasks);
    expect(loadActiveTasks()).toEqual(tasks);
  });

  it('appends task logs into a daily jsonl file', () => {
    appendTaskLog({
      task_id: 'task-1',
      run_at: '2026-03-20T01:00:00.000Z',
      duration_ms: 12,
      status: 'success',
      result: 'done',
      error: null,
    });

    expect(
      fs
        .readFileSync(_internals.taskLogPath('2026-03-20'), 'utf-8')
        .trim()
        .includes('"task_id":"task-1"'),
    ).toBe(true);
  });
});
