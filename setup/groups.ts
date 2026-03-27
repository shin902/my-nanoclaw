/**
 * ステップ: groups — メッセージングプラットフォームからグループのメタデータを取得し、DB に書き込みます。
 * WhatsApp は事前同期が必要です（Baileys の groupFetchAllParticipating）。
 * 他のチャネルは実行時にグループ名を検出するため、このステップは自動的にスキップされます。
 * 05-sync-groups.sh + 05b-list-groups.sh を置き換えるものです。
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  await syncGroups(projectRoot);
}

async function listGroups(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    console.error('エラー: データベースが見つかりません');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
     WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__' AND name <> jid
     ORDER BY last_message_time DESC
     LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
  db.close();

  for (const row of rows) {
    console.log(`${row.jid}|${row.name}`);
  }
}

async function syncGroups(projectRoot: string): Promise<void> {
  // 事前のグループ同期が必要なのは WhatsApp のみです。他のチャネルは実行時に名前を解決します。
  // ディスク上の認証情報の有無で WhatsApp を検出します。
  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasWhatsAppAuth =
    fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  if (!hasWhatsAppAuth) {
    logger.info('WhatsApp の認証情報が見つかりません — グループ同期をスキップします');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'skipped',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      REASON: 'whatsapp_not_configured',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // 最初に TypeScript をビルド
  logger.info('TypeScript をビルド中');
  let buildOk = false;
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('ビルド成功');
  } catch {
    logger.error('ビルド失敗');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'failed',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // node -e によるシェルのエスケープ問題を避けるため、一時ファイルを介して同期スクリプトを実行
  logger.info('グループのメタデータを取得中');
  let syncOk = false;
  try {
    const syncScript = `
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const logger = pino({ level: 'silent' });
const authDir = path.join('store', 'auth');
const dbPath = path.join('store', 'messages.db');

if (!fs.existsSync(authDir)) {
  console.error('NO_AUTH');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)');

const upsert = db.prepare(
  'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name'
);

const { state, saveCreds } = await useMultiFileAuthState(authDir);

const sock = makeWASocket({
  auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
  printQRInTerminal: false,
  logger,
  browser: Browsers.macOS('Chrome'),
});

const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(1);
}, 30000);

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (update) => {
  if (update.connection === 'open') {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const now = new Date().toISOString();
      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          upsert.run(jid, metadata.subject, now);
          count++;
        }
      }
      console.log('SYNCED:' + count);
    } catch (err) {
      console.error('FETCH_ERROR:' + err.message);
    } finally {
      clearTimeout(timeout);
      sock.end(undefined);
      db.close();
      process.exit(0);
    }
  } else if (update.connection === 'close') {
    clearTimeout(timeout);
    console.error('CONNECTION_CLOSED');
    process.exit(1);
  }
});
`;

    const tmpScript = path.join(projectRoot, '.tmp-group-sync.mjs');
    fs.writeFileSync(tmpScript, syncScript, 'utf-8');
    try {
      const output = execSync(`node ${tmpScript}`, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 45000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      syncOk = output.includes('SYNCED:');
      logger.info({ output: output.trim() }, '同期出力');
    } finally {
      try { fs.unlinkSync(tmpScript); } catch { /* クリーンアップエラーは無視 */ }
    }
  } catch (err) {
    logger.error({ err }, '同期失敗');
  }

  // better-sqlite3 を使用して DB 内のグループをカウント（sqlite3 CLI は不使用）
  let groupsInDb = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM chats WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__'",
        )
        .get() as { count: number };
      groupsInDb = row.count;
      db.close();
    } catch {
      // DB がまだ存在しない可能性あり
    }
  }

  const status = syncOk ? 'success' : 'failed';

  emitStatus('SYNC_GROUPS', {
    BUILD: buildOk ? 'success' : 'failed',
    SYNC: syncOk ? 'success' : 'failed',
    GROUPS_IN_DB: groupsInDb,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
