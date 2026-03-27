import fs from 'fs';
import path from 'path';

import { DATA_DIR, WORKSPACE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { saveSession } from '../src/store.js';
import { emitStatus } from './status.js';

interface RegisterArgs {
  chatId: string;
  name: string;
  assistantName: string;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    chatId: '',
    name: '',
    assistantName: 'Andy',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
      case '--chat-id':
        result.chatId = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.chatId || !parsed.name) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  logger.info(parsed, 'チャットセッションを登録中');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'conversations'), { recursive: true });

  saveSession({
    chatId: parsed.chatId,
    name: parsed.name,
  });

  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    const mdFiles = [
      path.join(projectRoot, 'groups', 'global', 'CLAUDE.md'),
      path.join(WORKSPACE_DIR, 'CLAUDE.md'),
    ];

    for (const mdFile of mdFiles) {
      if (!fs.existsSync(mdFile)) continue;
      let content = fs.readFileSync(mdFile, 'utf-8');
      content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
      content = content.replace(/You are Andy/g, `You are ${parsed.assistantName}`);
      fs.writeFileSync(mdFile, content);
      logger.info({ file: mdFile }, 'CLAUDE.md を更新しました');
    }

    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    CHAT_ID: parsed.chatId,
    NAME: parsed.name,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
