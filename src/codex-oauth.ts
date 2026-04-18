import fs from 'fs';
import path from 'path';

const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const EXPIRY_SKEW_MS = 30_000;

interface CodexCliAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface ParsedCodexCliAuth {
  root: CodexCliAuthFile;
  credentials: CodexOAuthCredentials;
}

interface CodexOAuthSource {
  sourceKey: string;
  authPath?: string;
  oauthJson?: string;
}

interface CachedCodexState extends CodexOAuthSource {
  root: CodexCliAuthFile;
  credentials: CodexOAuthCredentials;
}

export interface CodexOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface ResolveCodexOAuthApiKeyOptions {
  authPath?: string;
  oauthJson?: string;
}

export interface ResolveCodexOAuthApiKeyResult {
  apiKey: string;
  credentials: CodexOAuthCredentials;
}

const cachedCodexStateBySource = new Map<string, CachedCodexState>();
const refreshInFlightBySource = new Map<
  string,
  Promise<CodexOAuthCredentials>
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;

  try {
    return JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function getExpiryFromJwt(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

function getAccountIdFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;

  const authClaim = payload['https://api.openai.com/auth'];
  if (!isRecord(authClaim)) return undefined;

  const accountId = authClaim.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0
    ? accountId
    : undefined;
}

function parseCodexCliAuth(
  value: unknown,
  sourceLabel: string,
): ParsedCodexCliAuth {
  if (!isRecord(value)) {
    throw new Error(
      `[codex-oauth] ${sourceLabel} must be Codex CLI auth JSON (object).`,
    );
  }

  const root = value as CodexCliAuthFile;
  const tokens = root.tokens;
  if (!isRecord(tokens)) {
    throw new Error(
      `[codex-oauth] ${sourceLabel} must contain tokens.access_token and tokens.refresh_token.`,
    );
  }

  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== 'string' || typeof refresh !== 'string') {
    throw new Error(
      `[codex-oauth] ${sourceLabel} must contain tokens.access_token and tokens.refresh_token.`,
    );
  }

  const expires = getExpiryFromJwt(access);
  if (typeof expires !== 'number') {
    throw new Error(
      `[codex-oauth] ${sourceLabel} has invalid access_token (missing JWT exp claim).`,
    );
  }

  const accountId =
    typeof tokens.account_id === 'string'
      ? tokens.account_id
      : getAccountIdFromJwt(access);

  return {
    root,
    credentials: {
      access,
      refresh,
      expires,
      ...(accountId ? { accountId } : {}),
    },
  };
}

function parseCodexOAuthJsonInput(
  jsonText: string,
  sourceLabel: string,
): ParsedCodexCliAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `[codex-oauth] ${sourceLabel} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseCodexCliAuth(parsed, sourceLabel);
}

function readCodexAuthFile(authPath: string): string {
  const resolvedPath = path.resolve(authPath);

  try {
    return fs.readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `[codex-oauth] Codex auth file was not found: ${resolvedPath}. Run "codex login" or set OAS_CODEX_AUTH_PATH.`,
      );
    }
    throw new Error(
      `[codex-oauth] Failed to read Codex auth file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveSource(
  options: ResolveCodexOAuthApiKeyOptions,
): CodexOAuthSource {
  if (options.oauthJson) {
    return {
      sourceKey: `oauth-json:${options.oauthJson}`,
      oauthJson: options.oauthJson,
    };
  }

  if (options.authPath) {
    const resolvedPath = path.resolve(options.authPath);
    return {
      sourceKey: `auth-path:${resolvedPath}`,
      authPath: resolvedPath,
    };
  }

  throw new Error(
    '[codex-oauth] No Codex OAuth source configured. Set OAS_CODEX_AUTH_PATH or OAS_CODEX_OAUTH_JSON.',
  );
}

function loadCachedState(source: CodexOAuthSource): CachedCodexState {
  if (source.oauthJson) {
    const parsed = parseCodexOAuthJsonInput(
      source.oauthJson,
      'OAS_CODEX_OAUTH_JSON',
    );

    return {
      ...source,
      root: parsed.root,
      credentials: parsed.credentials,
    };
  }

  if (!source.authPath) {
    throw new Error(
      '[codex-oauth] No Codex auth path configured. Set OAS_CODEX_AUTH_PATH.',
    );
  }

  const raw = readCodexAuthFile(source.authPath);
  const parsed = parseCodexOAuthJsonInput(
    raw,
    `Codex auth file (${source.authPath})`,
  );

  return {
    ...source,
    root: parsed.root,
    credentials: parsed.credentials,
  };
}

function getOrLoadCachedState(source: CodexOAuthSource): CachedCodexState {
  const cached = cachedCodexStateBySource.get(source.sourceKey);
  if (cached) {
    return cached;
  }

  const loaded = loadCachedState(source);
  cachedCodexStateBySource.set(source.sourceKey, loaded);
  return loaded;
}

function serializeCodexCliAuth(
  root: CodexCliAuthFile,
  credentials: CodexOAuthCredentials,
): string {
  const tokens = isRecord(root.tokens) ? root.tokens : {};
  const updated: CodexCliAuthFile = {
    ...root,
    tokens: {
      ...tokens,
      access_token: credentials.access,
      refresh_token: credentials.refresh,
      ...(credentials.accountId ? { account_id: credentials.accountId } : {}),
    },
  };
  return JSON.stringify(updated, null, 2) + '\n';
}

function shouldRefresh(credentials: CodexOAuthCredentials): boolean {
  return Date.now() + EXPIRY_SKEW_MS >= credentials.expires;
}

async function refreshCodexOAuthCredentials(
  refreshToken: string,
): Promise<CodexOAuthCredentials> {
  let response: Response;
  try {
    response = await fetch(OPENAI_CODEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new Error(
      `[codex-oauth] Failed to refresh OpenAI Codex OAuth token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `[codex-oauth] OpenAI Codex OAuth refresh failed with status ${response.status}${body ? `: ${body}` : ''}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const accessToken = json.access_token;
  const nextRefreshToken = json.refresh_token;
  const expiresIn = json.expires_in;

  if (
    typeof accessToken !== 'string' ||
    typeof nextRefreshToken !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error(
      '[codex-oauth] OpenAI Codex OAuth refresh response is missing required fields.',
    );
  }

  const accountId = getAccountIdFromJwt(accessToken);

  return {
    access: accessToken,
    refresh: nextRefreshToken,
    expires: Date.now() + expiresIn * 1000,
    ...(accountId ? { accountId } : {}),
  };
}

async function refreshCachedState(
  cached: CachedCodexState,
): Promise<CodexOAuthCredentials> {
  const existing = refreshInFlightBySource.get(cached.sourceKey);
  if (existing) {
    return await existing;
  }

  const refreshPromise = (async () => {
    const refreshed = await refreshCodexOAuthCredentials(
      cached.credentials.refresh,
    );
    cached.credentials = refreshed;

    if (cached.authPath && !cached.oauthJson) {
      const serialized = serializeCodexCliAuth(cached.root, refreshed);
      fs.writeFileSync(cached.authPath, serialized, 'utf-8');
    }

    return refreshed;
  })();

  refreshInFlightBySource.set(cached.sourceKey, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (refreshInFlightBySource.get(cached.sourceKey) === refreshPromise) {
      refreshInFlightBySource.delete(cached.sourceKey);
    }
  }
}

export function validateCodexOAuthJson(oauthJson: string): void {
  parseCodexOAuthJsonInput(oauthJson, 'OAS_CODEX_OAUTH_JSON');
}

export function validateCodexAuthFile(authPath: string): void {
  const resolvedPath = path.resolve(authPath);
  const raw = readCodexAuthFile(resolvedPath);

  parseCodexOAuthJsonInput(raw, `Codex auth file (${resolvedPath})`);
}

export async function resolveCodexOAuthApiKey(
  options: ResolveCodexOAuthApiKeyOptions,
): Promise<ResolveCodexOAuthApiKeyResult> {
  const source = resolveSource(options);
  const cached = getOrLoadCachedState(source);

  if (shouldRefresh(cached.credentials)) {
    await refreshCachedState(cached);
  }

  return {
    apiKey: cached.credentials.access,
    credentials: cached.credentials,
  };
}

export function __resetCodexOAuthCacheForTests(): void {
  cachedCodexStateBySource.clear();
  refreshInFlightBySource.clear();
}
