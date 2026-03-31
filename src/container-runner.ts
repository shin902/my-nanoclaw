/**
 * NanoClaw 用コンテナランナー
 * コンテナ内でのエージェントの実行を開始し、IPC を処理します
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
  WORKSPACE_DIR,
} from './config.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { safeChatId } from './store.js';
import { ChatSession } from './types.js';

// 堅牢な出力パースのためのセンチネルマーカー (agent-runner と一致させる必要があります)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  chatId: string;
  model: string;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const workspaceClaudeDir = path.join(DATA_DIR, '.claude');
  const workspaceIpcDir = path.join(DATA_DIR, 'ipc');
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(workspaceClaudeDir, 'skills');

  const groupDir = WORKSPACE_DIR;
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace',
    readonly: false,
  });

  fs.mkdirSync(path.join(workspaceClaudeDir, 'projects'), { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: workspaceClaudeDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  fs.mkdirSync(path.join(workspaceIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(workspaceIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(workspaceIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: workspaceIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });
  mounts.push({
    hostPath: projectRoot,
    containerPath: '/workspace/project',
    readonly: false,
  });

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // コンテナのローカル時間がユーザーと一致するようにホストのタイムゾーンを渡す
  args.push('-e', `TZ=${TIMEZONE}`);

  // API トラフィックを認証情報プロキシ経由でルーティング（コンテナは実際のシークレットを関知しない）
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // ホストの認証方法をプレースホルダー値でミラーリング
  // API キーモード: SDK は x-api-key を送信し、プロキシが本物のキーに置き換える
  // OAuth モード:   SDK はプレースホルダー・トークンを一時的な API キーに交換し、
  //               プロキシはその交換リクエストに実際の OAuth トークンを注入する
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // ホストゲートウェイ解決のためのランタイム固有の引数
  args.push(...hostGatewayArgs());

  // SSH Agent Forwarding: コンテナ内の Git コマンドがホストの SSH キーにアクセス可能にする
  // (秘密鍵ファイル自体はコンテナから見えず、ホスト側の ssh-agent 経由でのみアクセス)
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  if (sshAuthSock) {
    args.push('-v', `${sshAuthSock}:${sshAuthSock}`);
    args.push('-e', `SSH_AUTH_SOCK=${sshAuthSock}`);
  }

  // バインドマウントされたファイルにアクセスできるよう、ホストユーザーとして実行。
  // root (uid 0)、コンテナの node ユーザー (uid 1000)、または
  // getuid が利用できない場合（WSL ではないネイティブ Windows）はスキップ。
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  session: ChatSession,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = WORKSPACE_DIR;
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const mounts = buildVolumeMounts();
  const safeName = safeChatId(session.chatId).replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      chatId: session.chatId,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      chatId: session.chatId,
      containerName,
      mountCount: mounts.length,
      model: input.model,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // ストリーミング出力: 到着した OUTPUT_START/END マーカーのペアをパース
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // 常にログ用に蓄積
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { chatId: session.chatId, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // 出力マーカーをストリームパース
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // 不完全なペア。次のデータを待つ

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // アクティビティを検出 — ハードタイムアウトをリセット
            resetTimeout();
            // 「サイレント」なクエリ完了でもアイドルタイマーが開始されるよう、
            // すべてのマーカー（null 結果を含む）に対して onOutput を呼び出す。
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { chatId: session.chatId, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: session.chatId }, line);
      }
      // stderr ではタイムアウトをリセットしない — SDK はデバッグログを常に出力するため。
      // タイムアウトは、実際の出力（stdout 内の OUTPUT_MARKER）に対してのみリセットされる。
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { chatId: session.chatId, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = session.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // 猶予期間: ハード kill が発動する前に、グレースフルな _close センチネルが発動する
    // 時間を確保するため、ハードタイムアウトは少なくとも IDLE_TIMEOUT + 30秒である必要があります。
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { chatId: session.chatId, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { chatId: session.chatId, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // アクティビティ（ストリーミング出力）があるたびにタイムアウトをリセット
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Chat ID: ${session.chatId}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // 出力後のタイムアウト = 失敗ではなく、アイドルのクリーンアップ。
        // エージェントはすでに応答を送信済み。これはアイドル期間が経過した後に
        // コンテナが回収されただけである。
        if (hadStreamingOutput) {
          logger.info(
            { chatId: session.chatId, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { chatId: session.chatId, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Chat ID: ${session.chatId}`,
        `Model: ${input.model}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            chatId: session.chatId,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // ストリーミングモード: 出力チェーンが落ち着くのを待ち、完了マーカーを返す
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { chatId: session.chatId, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // レガシーモード: 蓄積された stdout から最後の出力マーカーペアをパース
      try {
        // 堅牢なパースのため、センチネルマーカー間の JSON を抽出
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // フォールバック: 最後の空でない行（後方互換性）
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            chatId: session.chatId,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            chatId: session.chatId,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { chatId: session.chatId, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  tasks: Array<{
    id: string;
    chatId: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const tasksDir = path.join(DATA_DIR, 'ipc', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const tasksByChat = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const chatTasks = tasksByChat.get(task.chatId) || [];
    chatTasks.push(task);
    tasksByChat.set(task.chatId, chatTasks);
  }

  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(tasksDir, entry.name, 'current_tasks.json');
    let existingChatId: string;
    try {
      existingChatId = decodeURIComponent(entry.name);
    } catch {
      continue;
    }
    if (fs.existsSync(filePath) && !tasksByChat.has(existingChatId)) {
      fs.unlinkSync(filePath);
    }
  }

  for (const [chatId, chatTasks] of tasksByChat.entries()) {
    const snapshotDir = path.join(tasksDir, safeChatId(chatId));
    fs.mkdirSync(snapshotDir, { recursive: true });
    const filePath = path.join(snapshotDir, 'current_tasks.json');
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(chatTasks, null, 2));
    fs.renameSync(tempPath, filePath);
  }
}

export interface AvailableChat {
  chatId: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * コンテナが読み取るための利用可能なチャット一覧のスナップショットを書き込みます。
 * 現在は権限差分を設けず、すべてのチャットで同じ一覧を共有します。
 */
export function writeGroupsSnapshot(chats: AvailableChat[]): void {
  const ipcDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcDir, { recursive: true });
  const groupsFile = path.join(ipcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        chats,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
