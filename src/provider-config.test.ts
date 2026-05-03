import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};
const mockFiles = new Map<string, string>();

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((filePath: string) => mockFiles.has(filePath)),
      readFileSync: vi.fn((filePath: string) => {
        const value = mockFiles.get(filePath);
        if (value === undefined) {
          throw new Error(`ENOENT: ${filePath}`);
        }
        return value;
      }),
      statSync: vi.fn((filePath: string) => {
        if (!mockFiles.has(filePath)) {
          throw new Error(`ENOENT: ${filePath}`);
        }
        return { mtimeMs: Date.now() } as ReturnType<typeof actual.statSync>;
      }),
    },
    existsSync: vi.fn((filePath: string) => mockFiles.has(filePath)),
    readFileSync: vi.fn((filePath: string) => {
      const value = mockFiles.get(filePath);
      if (value === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return value;
    }),
    statSync: vi.fn((filePath: string) => {
      if (!mockFiles.has(filePath)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return { mtimeMs: Date.now() } as ReturnType<typeof actual.statSync>;
    }),
  };
});

import {
  buildContainerProviderEnv,
  invalidateNanoclawYamlCache,
  resolveProviderConfig,
  resolveProviderExecutionConfig,
} from './provider-config.js';

function resetMockEnv(): void {
  for (const key of Object.keys(mockEnv)) {
    delete mockEnv[key];
  }
}

describe('provider-config', () => {
  beforeEach(() => {
    resetMockEnv();
    mockFiles.clear();
    invalidateNanoclawYamlCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMockEnv();
  });

  it('falls back to legacy env detection when nanoclaw.yaml is absent', () => {
    Object.assign(mockEnv, {
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_BASE_URL: 'https://example.openai.local',
      OPENAI_MODEL: 'gpt-4.1',
    });

    const config = resolveProviderConfig();

    expect(config.source).toBe('env');
    expect(config.defaultProvider).toBe('default');
    expect(config.fallbackProviders).toEqual([]);
    expect(config.providers.default).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      usesCredentialProxy: true,
      apiKey: 'sk-openai',
      upstreamBaseURL: 'https://example.openai.local',
    });
  });

  it('falls back to legacy env detection with opencode-go when nanoclaw.yaml is absent', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OAS_CODEX_AUTH_PATH', '');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'sk-go-key');
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'sk-go-key',
    });

    const config = resolveProviderConfig();

    expect(config.source).toBe('env');
    expect(config.defaultProvider).toBe('default');
    expect(config.fallbackProviders).toEqual([]);
    expect(config.providers.default).toMatchObject({
      provider: 'opencode-go',
      model: 'deepseek-v4-pro',
      usesCredentialProxy: true,
      allowDirectSecretInjection: false,
      apiKey: 'sk-go-key',
      upstreamBaseURL: 'https://opencode.ai/zen/go',
    });
  });

  it('loads named providers from nanoclaw.yaml', () => {
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  claude:',
        '    provider: anthropic',
        '    model: claude-sonnet-4-6',
        '  fast:',
        '    provider: openai',
        '    model: gpt-4.1-mini',
        'defaultProvider: claude',
        'fallbacks:',
        '  - fast',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
    });

    const config = resolveProviderConfig();

    expect(config.source).toBe('yaml');
    expect(config.defaultProvider).toBe('claude');
    expect(config.fallbackProviders).toEqual(['fast']);
    expect(config.providers.claude).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(config.providers.fast).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });
  });

  it('requires direct injection opt-in for google providers in yaml', () => {
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  gemini:',
        '    provider: google',
        '    model: gemini-2.5-flash',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      GEMINI_API_KEY: 'gem-key',
    });

    expect(() => resolveProviderConfig()).toThrow(
      'ALLOW_DIRECT_SECRET_INJECTION=true is not set',
    );
  });

  it('reorders execution to start with the group-selected provider', () => {
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  claude:',
        '    provider: anthropic',
        '    model: claude-sonnet-4-6',
        '  fast:',
        '    provider: openai',
        '    model: gpt-4.1-mini',
        '  gemini:',
        '    provider: google',
        '    model: gemini-2.5-flash',
        'defaultProvider: claude',
        'fallbacks:',
        '  - fast',
        '  - gemini',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      GEMINI_API_KEY: 'gem-key',
      ALLOW_DIRECT_SECRET_INJECTION: 'true',
    });

    const config = resolveProviderConfig();
    const execution = resolveProviderExecutionConfig(config, 'fast');

    expect(execution.defaultProvider).toBe('fast');
    expect(execution.fallbackProviders).toEqual(['claude', 'gemini']);
  });

  it('resolves opencode-go provider from nanoclaw.yaml with default base URL', () => {
    vi.stubEnv('OPENCODE_GO_API_KEY', 'go-key');
    vi.stubEnv('OPENCODE_GO_BASE_URL', '');
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  go:',
        '    provider: opencode-go',
        '    model: deepseek-v4-pro',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'go-key',
    });

    const config = resolveProviderConfig();

    expect(config.source).toBe('yaml');
    expect(config.defaultProvider).toBe('go');
    expect(config.providers.go).toMatchObject({
      provider: 'opencode-go',
      model: 'deepseek-v4-pro',
      usesCredentialProxy: true,
      allowDirectSecretInjection: false,
      apiKey: 'go-key',
      upstreamBaseURL: 'https://opencode.ai/zen/go',
    });
  });

  it('respects OPENCODE_GO_BASE_URL override', () => {
    vi.stubEnv('OPENCODE_GO_API_KEY', 'go-key');
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://custom.opencode.example/v1');
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  go:',
        '    provider: opencode-go',
        '    model: kimi-k2.6',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'go-key',
      OPENCODE_GO_BASE_URL: 'https://custom.opencode.example/v1',
    });

    const config = resolveProviderConfig();

    expect(config.providers.go).toMatchObject({
      upstreamBaseURL: 'https://custom.opencode.example/v1',
    });
  });

  it('maps opencode-go to openai provider with proxy URL in container env', () => {
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  go:',
        '    provider: opencode-go',
        '    model: deepseek-v4-pro',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'go-key',
    });

    const config = resolveProviderConfig();
    const env = buildContainerProviderEnv(
      config,
      undefined,
      'host.docker.internal',
      3001,
    );
    const parsed = JSON.parse(env.NANOCLAW_PROVIDER_CONFIG_JSON);

    expect(parsed.defaultProvider).toBe('go');
    expect(parsed.providers.go).toEqual({
      provider: 'openai',
      model: 'deepseek-v4-pro',
      apiKey: 'placeholder-go',
      baseURL: 'http://host.docker.internal:3001/__provider/go',
    });
  });

  it('uses model configured in nanoclaw.yaml', () => {
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  go:',
        '    provider: opencode-go',
        '    model: kimi-k2.6',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'go-key',
    });

    const config = resolveProviderConfig();

    expect(config.providers.go.model).toBe('kimi-k2.6');
  });

  it('uses OPENCODE_GO_MODEL env var as model when resolving via legacy env (no yaml)', () => {
    // YAML なしの場合、OPENCODE_GO_MODEL が model の優先ソースになる
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OAS_CODEX_AUTH_PATH', '');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'go-key');
    vi.stubEnv('OPENCODE_GO_MODEL', 'kimi-k2.6');
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'go-key',
      OPENCODE_GO_MODEL: 'kimi-k2.6',
    });

    const config = resolveProviderConfig();

    expect(config.source).toBe('env');
    expect(config.providers.default.model).toBe('kimi-k2.6');
  });

  it('does not require ALLOW_DIRECT_SECRET_INJECTION for opencode-go', () => {
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  go:',
        '    provider: opencode-go',
        '    model: deepseek-v4-pro',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      OPENCODE_GO_API_KEY: 'go-key',
      // ALLOW_DIRECT_SECRET_INJECTION は設定しない
    });

    expect(() => resolveProviderConfig()).not.toThrow();
  });

  it('builds container env with proxy URLs and direct secrets', () => {
    // process.env の実キーが mock を上書きしないよう stub する
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('GEMINI_API_KEY', 'gem-key');
    vi.stubEnv('ALLOW_DIRECT_SECRET_INJECTION', 'true');
    mockFiles.set(
      `${process.cwd()}/nanoclaw.yaml`,
      [
        'providers:',
        '  claude:',
        '    provider: anthropic',
        '    model: claude-sonnet-4-6',
        '  fast:',
        '    provider: openai',
        '    model: gpt-4.1-mini',
        '  gemini:',
        '    provider: google',
        '    model: gemini-2.5-flash',
        'defaultProvider: claude',
        'fallbacks:',
        '  - fast',
        '  - gemini',
      ].join('\n'),
    );
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      GEMINI_API_KEY: 'gem-key',
      ALLOW_DIRECT_SECRET_INJECTION: 'true',
    });

    const config = resolveProviderConfig();
    const env = buildContainerProviderEnv(
      config,
      'fast',
      'host.docker.internal',
      3001,
    );

    const parsed = JSON.parse(env.NANOCLAW_PROVIDER_CONFIG_JSON);
    expect(parsed.defaultProvider).toBe('fast');
    expect(parsed.fallbackProviders).toEqual(['claude', 'gemini']);
    expect(parsed.providers.claude).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'placeholder-claude',
      baseURL: 'http://host.docker.internal:3001/__provider/claude',
    });
    expect(parsed.providers.fast).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'placeholder-fast',
      baseURL: 'http://host.docker.internal:3001/__provider/fast',
    });
    expect(parsed.providers.gemini).toEqual({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'gem-key',
    });
  });
});
