import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

function safeChatId(chatId: string): string {
  const trimmed = chatId.trim();
  return trimmed ? encodeURIComponent(trimmed) : 'chat';
}

function parseLocalOnceTimestamp(value: string): Date | null {
  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const chatId = process.env.NANOCLAW_CHAT_ID!.trim();
const SAFE_CHAT_ID = safeChatId(chatId);
const CHAT_MESSAGES_DIR = path.join(MESSAGES_DIR, SAFE_CHAT_ID);
const CHAT_TASKS_DIR = path.join(TASKS_DIR, SAFE_CHAT_ID);
const TASK_REQUESTS_DIR = path.join(CHAT_TASKS_DIR, 'requests');
const CURRENT_TASKS_FILE = path.join(CHAT_TASKS_DIR, 'current_tasks.json');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function readCurrentTasks(): Array<{ id: string; schedule_type: string }> {
  if (!fs.existsSync(CURRENT_TASKS_FILE)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(CURRENT_TASKS_FILE, 'utf-8')) as Array<{
      id: string;
      schedule_type: string;
    }>;
  } catch {
    return [];
  }
}

function invalidOnceTimestampResult(value: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `無効な once の時刻です: "${value}"。タイムゾーンなしのローカル時刻を指定してください。`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  '実行中にユーザーへメッセージを送信します。',
  {
    text: z.string().describe('送信するメッセージ本文'),
    sender: z.string().optional().describe('送信者名。現状は互換用です。'),
  },
  async (args) => {
    writeIpcFile(CHAT_MESSAGES_DIR, {
      type: 'message',
      chatId,
      text: args.text,
      sender: args.sender || undefined,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: 'メッセージを送信しました。' }],
    };
  },
);

server.tool(
  'schedule_task',
  '定期実行または単発のタスクをスケジュールします。',
  {
    prompt: z.string().describe('タスク実行時のプロンプト'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `無効な cron です: "${args.schedule_value}"。` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `無効なインターバルです: "${args.schedule_value}"。` }],
          isError: true,
        };
      }
    } else if (!parseLocalOnceTimestamp(args.schedule_value)) {
      return invalidOnceTimestampResult(args.schedule_value);
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASK_REQUESTS_DIR, {
      type: 'schedule_task',
      taskId,
      chatId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `タスク ${taskId} をスケジュールしました。` }],
    };
  },
);

server.tool('list_tasks', 'スケジュールされたタスクを一覧表示します。', {}, async () => {
  const tasksFile = path.join(
    CHAT_TASKS_DIR,
    'current_tasks.json',
  );

  try {
    if (!fs.existsSync(tasksFile)) {
      return { content: [{ type: 'text' as const, text: 'スケジュールされたタスクは見つかりませんでした。' }] };
    }

    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

    if (tasks.length === 0) {
      return { content: [{ type: 'text' as const, text: 'スケジュールされたタスクは見つかりませんでした。' }] };
    }

    const formatted = tasks
      .map(
        (task: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
          `- [${task.id}] ${task.prompt.slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`,
      )
      .join('\n');

    return {
      content: [{ type: 'text' as const, text: `スケジュールされたタスク:\n${formatted}` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `タスクの読み込みエラー: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
});

server.tool(
  'pause_task',
  'スケジュールされたタスクを一時停止します。',
  { task_id: z.string().describe('一時停止するタスクの ID') },
  async (args) => {
    writeIpcFile(TASK_REQUESTS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `タスク ${args.task_id} の一時停止をリクエストしました。` }],
    };
  },
);

server.tool(
  'resume_task',
  '一時停止中のタスクを再開します。',
  { task_id: z.string().describe('再開するタスクの ID') },
  async (args) => {
    writeIpcFile(TASK_REQUESTS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `タスク ${args.task_id} の再開をリクエストしました。` }],
    };
  },
);

server.tool(
  'cancel_task',
  'スケジュールされたタスクをキャンセルして削除します。',
  { task_id: z.string().describe('削除するタスクの ID') },
  async (args) => {
    writeIpcFile(TASK_REQUESTS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `タスク ${args.task_id} のキャンセルをリクエストしました。` }],
    };
  },
);

server.tool(
  'update_task',
  '既存のスケジュールタスクを更新します。',
  {
    task_id: z.string().describe('更新するタスクの ID'),
    prompt: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z.string().optional(),
  },
  async (args) => {
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `無効な cron です: "${args.schedule_value}"。` }],
            isError: true,
          };
        }
      }
    }

    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `無効なインターバルです: "${args.schedule_value}"。` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string> = {
      type: 'update_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASK_REQUESTS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `タスク ${args.task_id} の更新をリクエストしました。` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
