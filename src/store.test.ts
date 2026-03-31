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
    error: vi.fn(),
  },
}));

import {
  _internals,
  appendEvent,
  appendTaskLog,
  getSession,
  loadActiveTasks,
  loadSessions,
  readRecentEvents,
  readTodayEvents,
  safeChatId,
  saveActiveTasks,
  saveSession,
} from './store.js';
import type { ChatSession, GroupEvent, ScheduledTask } from './types.js';

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
    _internals.resetSessionsCache();
  });

  it('sanitizes chat ids for filesystem paths', () => {
    expect(safeChatId('dc:123/abc')).toBe('dc%3A123%2Fabc');
  });

  it('appends and reads events in chronological order for today', () => {
    const eventA: GroupEvent = {
      id: '1',
      chat_id: 'dc:1',
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
    appendEvent('dc:1', eventB);
    appendEvent('dc:1', eventA);

    expect(readTodayEvents('dc:1').map((event) => event.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('reads recent events across today and yesterday and applies limit', () => {
    vi.setSystemTime(new Date('2026-03-20T09:00:00.000Z'));

    const chatDir = path.join(_internals.CHATS_DATA_DIR, 'dc%3A1');
    writeJsonl(path.join(chatDir, '2026-03-19.jsonl'), [
      {
        id: 'a',
        chat_id: 'dc:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'yesterday',
        timestamp: '2026-03-19T23:59:59.000Z',
      },
    ]);
    writeJsonl(path.join(chatDir, '2026-03-20.jsonl'), [
      {
        id: 'b',
        chat_id: 'dc:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'today-1',
        timestamp: '2026-03-20T00:00:01.000Z',
      },
      {
        id: 'c',
        chat_id: 'dc:1',
        sender: 'u1',
        sender_name: 'Alice',
        content: 'today-2',
        timestamp: '2026-03-20T00:00:02.000Z',
      },
    ]);

    expect(readRecentEvents('dc:1', 2).map((event) => event.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('saves and loads sessions atomically', () => {
    const session: ChatSession = {
      chatId: 'dc:1',
      name: 'general',
      model: 'claude-sonnet-4-6',
      sessionId: 'session-123',
      resumeAt: '2026-03-20T00:00:00.000Z',
      containerConfig: { timeout: 1234 },
    };

    saveSession(session);

    expect(getSession('dc:1')).toEqual(session);
    expect(fs.existsSync(`${_internals.SESSIONS_PATH}.tmp`)).toBe(false);
  });

  it('lists saved sessions', () => {
    saveSession({
      chatId: 'dc:1',
      name: 'group-a',
      model: 'claude-sonnet-4-6',
    });

    expect(loadSessions()).toEqual([
      expect.objectContaining({ chatId: 'dc:1', name: 'group-a' }),
    ]);
  });

  it('reuses the cached sessions map until the file changes', () => {
    saveSession({
      chatId: 'dc:1',
      name: 'group-a',
      model: 'claude-sonnet-4-6',
    });

    const readSpy = vi.spyOn(fs, 'readFileSync');

    expect(getSession('dc:1')?.chatId).toBe('dc:1');
    expect(getSession('dc:1')?.chatId).toBe('dc:1');
    expect(readSpy).not.toHaveBeenCalled();

    fs.writeFileSync(
      _internals.SESSIONS_PATH,
      JSON.stringify({
        'dc:1': {
          name: 'group-a',
          model: 'claude-opus-4-6',
        },
      }),
    );

    expect(getSession('dc:1')?.model).toBe('claude-opus-4-6');
    expect(readSpy).toHaveBeenCalled();
  });

  it('loads and saves active tasks', () => {
    const tasks: ScheduledTask[] = [
      {
        id: 'task-1',
        chat_id: 'dc:1',
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
