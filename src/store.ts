import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  GroupEvent,
  ScheduledTask,
  StoredGroupConfig,
  TaskRunLog,
} from './types.js';

const GROUPS_DATA_DIR = path.join(DATA_DIR, 'groups');
const TASKS_DATA_DIR = path.join(DATA_DIR, 'tasks');
const ACTIVE_TASKS_PATH = path.join(TASKS_DATA_DIR, 'active.json');
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_PROVIDER = 'claude';

function assertValidGroupFolder(groupFolder: string): void {
  if (!isValidGroupFolder(groupFolder)) {
    throw new Error(`Invalid group folder "${groupFolder}"`);
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function groupDataDir(groupFolder: string): string {
  assertValidGroupFolder(groupFolder);
  return path.join(GROUPS_DATA_DIR, groupFolder);
}

function groupEventsPath(groupFolder: string, date: string): string {
  return path.join(groupDataDir(groupFolder), `${date}.jsonl`);
}

function groupConfigPath(groupFolder: string): string {
  return path.join(groupDataDir(groupFolder), 'config.json');
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

export function appendEvent(groupFolder: string, event: GroupEvent): void {
  const dir = groupDataDir(groupFolder);
  ensureDir(dir);
  fs.appendFileSync(
    groupEventsPath(groupFolder, isoDate(event.timestamp)),
    `${JSON.stringify(event)}\n`,
  );
}

export function readTodayEvents(groupFolder: string): GroupEvent[] {
  return parseJsonlFile<GroupEvent>(
    groupEventsPath(groupFolder, isoDate(new Date())),
  ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function readRecentEvents(
  groupFolder: string,
  limit: number,
): GroupEvent[] {
  const today = isoDate(new Date());
  const events = [
    ...parseJsonlFile<GroupEvent>(
      groupEventsPath(groupFolder, yesterday(today)),
    ),
    ...parseJsonlFile<GroupEvent>(groupEventsPath(groupFolder, today)),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (limit <= 0) return [];
  return events.slice(-limit);
}

export function loadGroupConfig(groupFolder: string): StoredGroupConfig | null {
  const filePath = groupConfigPath(groupFolder);
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.error(
      `Failed to read group config for "${groupFolder}" at "${filePath}":`,
      err,
    );
    return null;
  }

  let parsed: Partial<StoredGroupConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredGroupConfig>;
  } catch (err) {
    logger.error(
      `Failed to parse JSON group config for "${groupFolder}" at "${filePath}":`,
      err,
    );
    return null;
  }
  return {
    jid: parsed.jid || '',
    name: parsed.name || groupFolder,
    folder: parsed.folder || groupFolder,
    model: parsed.model || DEFAULT_MODEL,
    provider: parsed.provider || DEFAULT_PROVIDER,
    sessionId: parsed.sessionId,
    resumeAt: parsed.resumeAt,
    added_at: parsed.added_at || new Date(0).toISOString(),
    containerConfig: parsed.containerConfig,
  };
}

export function saveGroupConfig(
  groupFolder: string,
  config: StoredGroupConfig,
): void {
  assertValidGroupFolder(groupFolder);
  atomicWriteJson(groupConfigPath(groupFolder), config);
}

export function listRegisteredGroups(): StoredGroupConfig[] {
  if (!fs.existsSync(GROUPS_DATA_DIR)) return [];

  return fs
    .readdirSync(GROUPS_DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadGroupConfig(entry.name))
    .filter((config): config is StoredGroupConfig => config !== null)
    .filter((config) => config.jid.length > 0);
}

export function loadActiveTasks(): ScheduledTask[] {
  if (!fs.existsSync(ACTIVE_TASKS_PATH)) return [];

  try {
    const raw = fs.readFileSync(ACTIVE_TASKS_PATH, 'utf-8');
    if (raw.trim() === '') return [];
    return JSON.parse(raw) as ScheduledTask[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fall back to an empty task list if the active tasks file is unreadable or invalid.
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
  GROUPS_DATA_DIR,
  TASKS_DATA_DIR,
  groupConfigPath,
  groupEventsPath,
  taskLogPath,
  yesterday,
};
