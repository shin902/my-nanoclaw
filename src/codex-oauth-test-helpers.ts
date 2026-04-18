interface MakeCodexCliAuthJsonOptions {
  expiresAtMs: number;
  accountId?: string;
  refreshToken?: string;
}

export function makeCodexAccessToken(
  expiresAtMs: number,
  accountId?: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');

  const payloadObj: Record<string, unknown> = {
    exp: Math.floor(expiresAtMs / 1000),
  };

  if (accountId) {
    payloadObj['https://api.openai.com/auth'] = {
      chatgpt_account_id: accountId,
    };
  }

  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${header}.${payload}.signature`;
}

export function makeCodexCliAuthJson(
  options: MakeCodexCliAuthJsonOptions,
): string {
  const refreshToken = options.refreshToken || 'codex-refresh-token';

  return JSON.stringify({
    auth_mode: 'oauth',
    tokens: {
      access_token: makeCodexAccessToken(options.expiresAtMs, options.accountId),
      refresh_token: refreshToken,
      ...(options.accountId ? { account_id: options.accountId } : {}),
    },
  });
}
