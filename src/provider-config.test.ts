import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

import {
  buildContainerProviderEnv,
  detectActiveProviderConfig,
} from './provider-config.js';
import { makeCodexCliAuthJson } from './codex-oauth-test-helpers.js';

const originalCodexHome = process.env.CODEX_HOME;

function resetMockEnv(): void {
  for (const key of Object.keys(mockEnv)) {
    delete mockEnv[key];
  }
}

describe('provider-config', () => {
  beforeEach(() => {
    resetMockEnv();
    process.env.CODEX_HOME = '/tmp/nanoclaw-provider-config-tests';
  });

  afterAll(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it('detects anthropic first when multiple provider keys exist', () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      GEMINI_API_KEY: 'gem-key',
      OAS_CODEX_OAUTH_JSON: makeCodexCliAuthJson({
        expiresAtMs: Date.now() + 60_000,
      }),
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.usesCredentialProxy).toBe(true);
    expect(config.allowDirectSecretInjection).toBe(false);
    expect(config.apiKey).toBe('sk-ant');
    expect(config.upstreamBaseURL).toBe('https://api.anthropic.com');
  });

  it('detects openai when anthropic key is absent', () => {
    Object.assign(mockEnv, {
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_BASE_URL: 'https://example.openai-proxy.local',
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('openai');
    expect(config.usesCredentialProxy).toBe(true);
    expect(config.allowDirectSecretInjection).toBe(false);
    expect(config.apiKey).toBe('sk-openai');
    expect(config.upstreamBaseURL).toBe('https://example.openai-proxy.local');
  });

  it('detects gemini as direct key injection mode when opt-in is enabled', () => {
    Object.assign(mockEnv, {
      GEMINI_API_KEY: 'gem-key',
      ALLOW_DIRECT_SECRET_INJECTION: 'true',
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('gemini');
    expect(config.usesCredentialProxy).toBe(false);
    expect(config.allowDirectSecretInjection).toBe(true);
    expect(config.apiKey).toBe('gem-key');
  });

  it('detects codex from oauth json when no API key providers exist', () => {
    Object.assign(mockEnv, {
      OAS_CODEX_OAUTH_JSON: makeCodexCliAuthJson({
        expiresAtMs: Date.now() + 60_000,
      }),
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('codex');
    expect(config.usesCredentialProxy).toBe(true);
    expect(config.allowDirectSecretInjection).toBe(false);
    expect(config.codexOAuthJson).toContain('access');
  });

  it('throws when gemini key is set without direct injection opt-in', () => {
    Object.assign(mockEnv, {
      GEMINI_API_KEY: 'gem-key',
    });

    expect(() => detectActiveProviderConfig()).toThrow(
      'ALLOW_DIRECT_SECRET_INJECTION=true is not set',
    );
  });

  it('throws when codex auth path is set but file does not exist', () => {
    Object.assign(mockEnv, {
      OAS_CODEX_AUTH_PATH: '/tmp/nanoclaw-missing-codex-auth.json',
    });

    expect(() => detectActiveProviderConfig()).toThrow(
      'Codex auth file was not found',
    );
  });

  it('throws when no supported provider config is present', () => {
    expect(() => detectActiveProviderConfig()).toThrow(
      'No supported provider credentials found',
    );
  });

  it('builds proxy-based container env for anthropic', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'anthropic',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
        apiKey: 'sk-ant',
        upstreamBaseURL: 'https://api.anthropic.com',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:3001',
      ANTHROPIC_API_KEY: 'placeholder',
    });
  });

  it('builds proxy-based container env for openai', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'openai',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
        apiKey: 'sk-openai',
        upstreamBaseURL: 'https://api.openai.com',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({
      OPENAI_BASE_URL: 'http://host.docker.internal:3001',
      OPENAI_API_KEY: 'placeholder',
    });
  });

  it('builds direct injection env for gemini', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'gemini',
        usesCredentialProxy: false,
        allowDirectSecretInjection: true,
        apiKey: 'gem-key',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({ GEMINI_API_KEY: 'gem-key' });
  });

  it('builds codex proxy env', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'codex',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({
      CODEX_BASE_URL: 'http://host.docker.internal:3001',
      CODEX_API_KEY: 'placeholder',
    });
  });

  it('throws when building gemini env without direct injection opt-in', () => {
    expect(() =>
      buildContainerProviderEnv(
        {
          provider: 'gemini',
          usesCredentialProxy: false,
          allowDirectSecretInjection: false,
          apiKey: 'gem-key',
        },
        'host.docker.internal',
        3001,
      ),
    ).toThrow('ALLOW_DIRECT_SECRET_INJECTION=true');
  });
});
