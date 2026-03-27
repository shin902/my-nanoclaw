import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { ChatSession, GroupEvent, ScheduledTask, TaskRunLog } from './types.js';

const CHATS_DATA_DIR = path.join(DATA_DIR, 'chats');
const TASKS_DATA_DIR = path.join(DATA_DIR, 'tasks');
const ACTIVE_TASKS_PATH = path.join(TASKS_DATA_DIR, 'active.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function taskLogPath(date: string): string {
  return path.join(TASKS_DATA_DIR, `${date}.jsonl`);
}

function isoDate(value: Date | string): string {
  return (typeof value === 'string' ? new Date(value) : value)
    .toISOString()
    .slice(0, 10);
}

function yesterday(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function parseJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];

  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const items: T[] = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line) as T);
    } catch (err) {
      logger.warn({ filePath, err }, 'Skipping invalid JSONL line');
    }
  }
  return items;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

function loadSessionsMap(): Record<string, ChatSession> {
  if (!fs.existsSync(SESSIONS_PATH)) return {};

  try {
    const raw = fs.readFileSync(SESSIONS_PATH, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<ChatSession>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([chatId, session]) => [
        chatId,
        normalizeSession(chatId, session),
      ]),
    );
  } catch (err) {
    logger.error({ err, filePath: SESSIONS_PATH }, 'Failed to load sessions');
    return {};
  }
}

function normalizeSession(
  chatId: string,
  session: Partial<ChatSession> | undefined,
): ChatSession {
  return {
    chatId,
    name: session?.name,
    sessionId: session?.sessionId,
    resumeAt: session?.resumeAt,
    model: session?.model || DEFAULT_MODEL,
    containerConfig: session?.containerConfig,
  };
}

function chatEventsPath(chatId: string, date: string): string {
  return path.join(CHATS_DATA_DIR, safeChatId(chatId), `${date}.jsonl`);
}

export function safeChatId(chatId: string): string {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return 'chat';
  }
  return encodeURIComponent(trimmed);
}

export function loadSessions(): ChatSession[] {
  return Object.values(loadSessionsMap()).sort((a, b) =>
    (a.name || a.chatId).localeCompare(b.name || b.chatId),
  );
}

export function listSessions(): ChatSession[] {
  return loadSessions();
}

export function getSession(chatId: string): ChatSession | null {
  const session = loadSessionsMap()[chatId];
  return session || null;
}

export function saveSession(session: ChatSession): void {
  const sessions = loadSessionsMap();
  sessions[session.chatId] = normalizeSession(session.chatId, session);
  atomicWriteJson(SESSIONS_PATH, sessions);
}

export function appendEvent(chatId: string, event: GroupEvent): void {
  const filePath = chatEventsPath(chatId, isoDate(event.timestamp));
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

export function readTodayEvents(chatId: string): GroupEvent[] {
  return parseJsonlFile<GroupEvent>(
    chatEventsPath(chatId, isoDate(new Date())),
  ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function readRecentEvents(chatId: string, limit: number): GroupEvent[] {
  const today = isoDate(new Date());
  const events = [
    ...parseJsonlFile<GroupEvent>(chatEventsPath(chatId, yesterday(today))),
    ...parseJsonlFile<GroupEvent>(chatEventsPath(chatId, today)),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (limit <= 0) return [];
  return events.slice(-limit);
}

export function loadActiveTasks(): ScheduledTask[] {
  if (!fs.existsSync(ACTIVE_TASKS_PATH)) return [];

  try {
    const raw = fs.readFileSync(ACTIVE_TASKS_PATH, 'utf-8');
    if (raw.trim() === '') return [];
    return JSON.parse(raw) as ScheduledTask[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn?.(
      `Failed to load active tasks from "${ACTIVE_TASKS_PATH}": ${message}`,
    );
    return [];
  }
}

export function saveActiveTasks(tasks: ScheduledTask[]): void {
  atomicWriteJson(ACTIVE_TASKS_PATH, tasks);
}

export function getTaskById(taskId: string): ScheduledTask | undefined {
  return loadActiveTasks().find((task) => task.id === taskId);
}

export function getAllTasks(): ScheduledTask[] {
  return loadActiveTasks().sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

export function getDueTasks(
  now: string = new Date().toISOString(),
): ScheduledTask[] {
  return getAllTasks()
    .filter(
      (task) =>
        task.status === 'active' &&
        task.next_run !== null &&
        task.next_run <= now,
    )
    .sort((a, b) => (a.next_run || '').localeCompare(b.next_run || ''));
}

export function upsertTask(task: ScheduledTask): void {
  const tasks = loadActiveTasks();
  const nextTasks = tasks.filter((entry) => entry.id !== task.id);
  nextTasks.push(task);
  saveActiveTasks(nextTasks);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'next_run'
      | 'last_run'
      | 'last_result'
      | 'status'
    >
  >,
): void {
  const tasks = loadActiveTasks();
  saveActiveTasks(
    tasks.map((task) => (task.id === id ? { ...task, ...updates } : task)),
  );
}

export function deleteTask(taskId: string): void {
  saveActiveTasks(loadActiveTasks().filter((task) => task.id !== taskId));
}

export function appendTaskLog(event: TaskRunLog): void {
  ensureDir(TASKS_DATA_DIR);
  fs.appendFileSync(
    taskLogPath(isoDate(event.run_at)),
    `${JSON.stringify(event)}\n`,
  );
}

export const _internals = {
  ACTIVE_TASKS_PATH,
  CHATS_DATA_DIR,
  SESSIONS_PATH,
  chatEventsPath,
  taskLogPath,
};
