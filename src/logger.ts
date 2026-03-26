import pino from 'pino';

const isTestEnv =
  process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isTestEnv
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});

// キャッチされなかったエラーを pino 経由で出力し、stderr にタイムスタンプを付与します
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
