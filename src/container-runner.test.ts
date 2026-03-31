import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
  WORKSPACE_DIR: '/tmp/nanoclaw-test-workspace',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { spawn } from 'child_process';
import type { ChatSession } from './types.js';

const testSession: ChatSession = {
  chatId: 'dc:test',
  name: 'Test Chat',
  model: 'claude-sonnet-4-6',
};

const testInput = {
  prompt: 'Hello',
  chatId: 'dc:test',
  model: 'claude-sonnet-4-6',
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testSession,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testSession,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testSession,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('mounts shared IPC read-only when disabled in container config', async () => {
    const session: ChatSession = {
      ...testSession,
      containerConfig: {
        sharedIpcWriteAccess: false,
      },
    };
    const resultPromise = runContainerAgent(session, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-789',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(spawn).toHaveBeenCalled();
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect(args).toContain('/tmp/nanoclaw-test-data/ipc:/workspace/ipc:ro');
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/ipc/messages/dc%3Atest:/workspace/ipc/messages/dc%3Atest',
    );
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/ipc/tasks/dc%3Atest:/workspace/ipc/tasks/dc%3Atest',
    );
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/ipc/input/dc%3Atest:/workspace/ipc/input/dc%3Atest',
    );
  });

  it('writes only the requested chat task snapshot', () => {
    const fsModule = vi.mocked(fs);
    fsModule.existsSync.mockReturnValue(false);

    writeTasksSnapshot(
      [
        {
          id: 'task-a',
          chatId: 'dc:test',
          prompt: 'hello',
          schedule_type: 'once',
          schedule_value: '2026-04-01T09:00:00',
          status: 'active',
          next_run: '2026-04-01T09:00:00.000Z',
        },
        {
          id: 'task-b',
          chatId: 'dc:other',
          prompt: 'world',
          schedule_type: 'once',
          schedule_value: '2026-04-01T10:00:00',
          status: 'active',
          next_run: '2026-04-01T10:00:00.000Z',
        },
      ],
      'dc:test',
    );

    expect(fsModule.readdirSync).not.toHaveBeenCalled();
    expect(fsModule.writeFileSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-data/ipc/tasks/dc%3Atest/current_tasks.json.tmp',
      expect.stringContaining('"id": "task-a"'),
    );
    expect(fsModule.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('dc%3Aother/current_tasks.json.tmp'),
      expect.anything(),
    );
  });
});
