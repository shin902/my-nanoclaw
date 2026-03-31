import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => {
  const root = `/tmp/nanoclaw-register-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    root,
    dataDir: `${root}/data`,
    workspaceDir: `${root}/workspace`,
  };
});

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return {
    ...actual,
    DATA_DIR: testPaths.dataDir,
    WORKSPACE_DIR: testPaths.workspaceDir,
  };
});

const emitStatus = vi.hoisted(() => vi.fn());

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./status.js', () => ({
  emitStatus,
}));

import { getSession } from '../src/store.js';
import { parseArgs, run } from './register.js';

describe('setup/register', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    fs.rmSync(testPaths.root, { recursive: true, force: true });
    fs.mkdirSync(testPaths.root, { recursive: true });
    fs.mkdirSync(testPaths.workspaceDir, { recursive: true });
    process.chdir(testPaths.root);
    emitStatus.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('parses both --jid and --chat-id', () => {
    expect(parseArgs(['--jid', 'dc:legacy', '--name', 'legacy'])).toEqual({
      chatId: 'dc:legacy',
      name: 'legacy',
      assistantName: 'Andy',
    });
    expect(parseArgs(['--chat-id', 'dc:new', '--name', 'new'])).toEqual({
      chatId: 'dc:new',
      name: 'new',
      assistantName: 'Andy',
    });
  });

  it('writes the session and updates workspace files', async () => {
    fs.mkdirSync(path.join(testPaths.root, 'groups', 'global'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(testPaths.root, 'groups', 'global', 'CLAUDE.md'),
      '# Andy\nYou are Andy\n',
    );
    fs.writeFileSync(
      path.join(testPaths.workspaceDir, 'CLAUDE.md'),
      '# Andy\nYou are Andy\n',
    );
    fs.writeFileSync(path.join(testPaths.root, '.env'), 'FOO=bar\n');

    await run([
      '--chat-id',
      'dc:test',
      '--name',
      'main',
      '--assistant-name',
      'Nano',
    ]);

    expect(getSession('dc:test')).toEqual(
      expect.objectContaining({
        chatId: 'dc:test',
        name: 'main',
      }),
    );
    expect(
      fs.readFileSync(path.join(testPaths.root, '.env'), 'utf-8'),
    ).toContain('ASSISTANT_NAME="Nano"');
    expect(
      fs.readFileSync(
        path.join(testPaths.root, 'groups', 'global', 'CLAUDE.md'),
        'utf-8',
      ),
    ).toContain('# Nano');
    expect(
      fs.readFileSync(path.join(testPaths.workspaceDir, 'CLAUDE.md'), 'utf-8'),
    ).toContain('You are Nano');
    expect(emitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({
        CHAT_ID: 'dc:test',
        NAME: 'main',
        ASSISTANT_NAME: 'Nano',
        NAME_UPDATED: true,
        STATUS: 'success',
      }),
    );
  });
});
