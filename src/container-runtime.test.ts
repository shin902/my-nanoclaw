import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.hoisted(() =>
  vi.fn<(command: unknown, options?: unknown) => unknown>(),
);
const mockExistsSync = vi.hoisted(() =>
  vi.fn<(filePath: unknown) => boolean>(() => false),
);
const mockNetworkInterfaces = vi.hoisted(() =>
  vi.fn<() => Record<string, Array<{ family: string; address: string }>>>(
    () => ({}),
  ),
);
const mockPlatform = vi.hoisted(() => vi.fn<() => string>(() => 'linux'));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execSync: (command: unknown, options?: unknown) =>
    mockExecSync(command, options),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (filePath: unknown) => mockExistsSync(filePath),
  },
}));

vi.mock('os', () => ({
  default: {
    platform: () => mockPlatform(),
    networkInterfaces: () => mockNetworkInterfaces(),
  },
}));

import { logger } from './logger.js';

async function loadModule() {
  vi.resetModules();
  return import('./container-runtime.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CREDENTIAL_PROXY_HOST;
  mockPlatform.mockReturnValue('linux');
  mockExistsSync.mockReturnValue(false);
  mockNetworkInterfaces.mockReturnValue({});
});

describe('runtime platform detection', () => {
  it('uses loopback bind host on macOS', async () => {
    mockPlatform.mockReturnValue('darwin');
    const mod = await loadModule();
    expect(mod.PROXY_BIND_HOST).toBe('127.0.0.1');
    expect(mod.hostGatewayArgs()).toEqual([]);
  });

  it('uses loopback bind host on WSL', async () => {
    mockExistsSync.mockReturnValue(true);
    const mod = await loadModule();
    expect(mod.PROXY_BIND_HOST).toBe('127.0.0.1');
  });

  it('uses docker0 address on Linux when present', async () => {
    mockNetworkInterfaces.mockReturnValue({
      docker0: [{ family: 'IPv4', address: '172.17.0.1' }],
    });
    const mod = await loadModule();
    expect(mod.PROXY_BIND_HOST).toBe('172.17.0.1');
    expect(mod.hostGatewayArgs()).toEqual([
      '--add-host=host.docker.internal:host-gateway',
    ]);
  });

  it('falls back to 0.0.0.0 on Linux without docker0', async () => {
    const mod = await loadModule();
    expect(mod.PROXY_BIND_HOST).toBe('0.0.0.0');
  });
});

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', async () => {
    const mod = await loadModule();
    expect(mod.readonlyMountArgs('/host/path', '/container/path')).toEqual([
      '-v',
      '/host/path:/container/path:ro',
    ]);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', async () => {
    const mod = await loadModule();
    expect(mod.stopContainer('nanoclaw-test-123')).toBe(
      `${mod.CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', async () => {
    mockExecSync.mockReturnValueOnce('');
    const mod = await loadModule();

    mod.ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${mod.CONTAINER_RUNTIME_BIN} info`,
      {
        stdio: 'pipe',
        timeout: 10000,
      },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    const mod = await loadModule();

    expect(() => mod.ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', async () => {
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    mockExecSync.mockReturnValue('');
    const mod = await loadModule();

    mod.cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${mod.CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${mod.CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', async () => {
    mockExecSync.mockReturnValueOnce('');
    const mod = await loadModule();

    mod.cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });
    const mod = await loadModule();

    mod.cleanupOrphans();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', async () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');
    const mod = await loadModule();

    mod.cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
