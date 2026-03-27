/**
 * ステップ: mounts — マウント許可リストの設定ファイルを書き込みます。
 * 07-configure-mounts.sh を置き換えるものです。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '../src/logger.js';
import { isRoot } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { empty: boolean; json: string } {
  let empty = false;
  let json = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--empty') empty = true;
    if (args[i] === '--json' && args[i + 1]) {
      json = args[i + 1];
      i++;
    }
  }
  return { empty, json };
}

export async function run(args: string[]): Promise<void> {
  const { empty, json } = parseArgs(args);
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'nanoclaw');
  const configFile = path.join(configDir, 'mount-allowlist.json');

  if (isRoot()) {
    logger.warn(
      'root として実行中 — マウント許可リストは root のホームディレクトリに書き込まれます',
    );
  }

  fs.mkdirSync(configDir, { recursive: true });

  let allowedRootsCount = 0;
  let nonMainReadOnly = 'true';

  if (empty) {
    logger.info('空のマウント許可リストを書き込み中');
    const emptyConfig = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(configFile, JSON.stringify(emptyConfig, null, 2) + '\n');
  } else if (json) {
    // JSON.parse で JSON を検証（シェルを介さない）
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(json);
    } catch {
      logger.error('無効な JSON 入力です');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return; // TS を満たすための unreachable
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRootsCount = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  } else {
    // 標準入力から読み込み
    logger.info('標準入力からマウント許可リストを読み込み中');
    const input = fs.readFileSync(0, 'utf-8');
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(input);
    } catch {
      logger.error('標準入力からの JSON が無効です');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return;
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRootsCount = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  }

  logger.info(
    { configFile, allowedRootsCount, nonMainReadOnly },
    '許可リストを設定しました',
  );

  emitStatus('CONFIGURE_MOUNTS', {
    PATH: configFile,
    ALLOWED_ROOTS: allowedRootsCount,
    NON_MAIN_READ_ONLY: nonMainReadOnly,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
