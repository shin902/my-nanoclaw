import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __getCodexOAuthCacheKeysForTests,
  __resetCodexOAuthCacheForTests,
  __resolveCodexAuthFileWriteModeForTests,
  resolveCodexOAuthApiKey,
} from './codex-oauth.js';
import { makeCodexAccessToken } from './codex-oauth-test-helpers.js';

describe('codex-oauth', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-oauth-'));
    __resetCodexOAuthCacheForTests();
  });

  afterEach(() => {
    __resetCodexOAuthCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses hashed oauth json cache keys and ignores formatting differences', async () => {
    const expiredAccessToken = makeCodexAccessToken(
      Date.now() - 60_000,
      'acct_123',
    );
    const refreshedAccessToken = makeCodexAccessToken(
      Date.now() + 3_600_000,
      'acct_123',
    );

    const oauthObject = {
      auth_mode: 'oauth',
      tokens: {
        access_token: expiredAccessToken,
        refresh_token: 'refresh-token-shared',
        account_id: 'acct_123',
      },
    };
    const compactJson = JSON.stringify(oauthObject);
    const prettyJson = JSON.stringify(oauthObject, null, 2);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'refresh-token-next',
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const first = await resolveCodexOAuthApiKey({ oauthJson: compactJson });
    const second = await resolveCodexOAuthApiKey({ oauthJson: prettyJson });

    expect(first.apiKey).toBe(refreshedAccessToken);
    expect(second.apiKey).toBe(refreshedAccessToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cacheKeys = __getCodexOAuthCacheKeysForTests();
    expect(cacheKeys).toHaveLength(1);
    expect(cacheKeys[0]).toMatch(/^oauth-json:[0-9a-f]{64}$/);
    expect(cacheKeys[0]).not.toContain('refresh-token-shared');
    expect(cacheKeys[0]).not.toContain(expiredAccessToken.slice(0, 12));
  });

  it('uses owner-only write mode defaults for auth file writes', () => {
    const missingAuthPath = path.join(tempDir, 'missing-auth.json');
    expect(__resolveCodexAuthFileWriteModeForTests(missingAuthPath)).toBe(
      0o600,
    );

    const existingAuthPath = path.join(tempDir, 'existing-auth.json');
    fs.writeFileSync(existingAuthPath, '{}');

    fs.chmodSync(existingAuthPath, 0o644);
    expect(__resolveCodexAuthFileWriteModeForTests(existingAuthPath)).toBe(
      0o600,
    );

    fs.chmodSync(existingAuthPath, 0o400);
    expect(__resolveCodexAuthFileWriteModeForTests(existingAuthPath)).toBe(
      0o400,
    );
  });
});
