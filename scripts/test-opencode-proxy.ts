#!/usr/bin/env tsx
/**
 * OpenCode Go プロキシ E2E 手動テスト
 *
 * 実際の OpenCode Go API にプロキシ経由でリクエストを送信し、
 * 大規模コンテキスト送受信時のタイムアウト・切断の有無を観測します。
 *
 * ⚠️ 注意: 実際の API を叩くためコストが発生します。手動実行のみで使用してください。
 *
 * 実行方法:
 *   npx tsx scripts/test-opencode-proxy.ts
 */

import http from 'http';
import https from 'https';
import { AddressInfo } from 'net';
import { readEnvFile } from '../src/env.js';
import { startCredentialProxy } from '../src/credential-proxy.js';
import { resolveProviderConfig } from '../src/provider-config.js';

// 既存 logger を import すると pino-pretty 等の依存が必要なので最小限のログを使用
function log(label: string, data?: unknown) {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] [${label}]`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(`[${ts}] [${label}]`);
  }
}

interface TestResult {
  name: string;
  success: boolean;
  requestBytes: number;
  responseBytes: number;
  ttfbMs: number;
  totalMs: number;
  chunks: number;
  error?: string;
}

function buildPayload(sizeChars: number): object {
  const baseMessage =
    'これはテストメッセージです。タイムアウトの原因を調査するために大量のコンテキストを送信します。';
  const repeatCount = Math.ceil(sizeChars / baseMessage.length);
  const largeContent = baseMessage.repeat(repeatCount).slice(0, sizeChars);

  return {
    model: 'kimi-k2.6',
    messages: [{ role: 'user', content: largeContent }],
    max_tokens: 1024,
  };
}

function buildStreamingPayload(sizeChars: number): object {
  return {
    ...buildPayload(sizeChars),
    stream: true,
  };
}

async function sendViaProxy(
  proxyPort: number,
  providerName: string,
  body: object,
  timeoutMs = 120_000,
): Promise<TestResult> {
  const startTime = Date.now();
  const payload = JSON.stringify(body);
  const result: TestResult = {
    name: `proxy->${providerName} ${payload.length} bytes`,
    success: false,
    requestBytes: payload.length,
    responseBytes: 0,
    ttfbMs: 0,
    totalMs: 0,
    chunks: 0,
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      result.error = `Timeout after ${timeoutMs}ms`;
      result.totalMs = Date.now() - startTime;
      resolve(result);
    }, timeoutMs);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: `/__provider/${encodeURIComponent(providerName)}/v1/chat/completions`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: 'Bearer placeholder',
        },
        // Node.js 標準のソケットタイムアウト（接続後の無通信タイムアウト）
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let firstChunk = true;

        res.on('data', (chunk: Buffer) => {
          if (firstChunk) {
            result.ttfbMs = Date.now() - startTime;
            firstChunk = false;
          }
          chunks.push(chunk);
          result.chunks++;
          result.responseBytes += chunk.length;
        });

        res.on('end', () => {
          clearTimeout(timer);
          result.totalMs = Date.now() - startTime;
          result.success = res.statusCode === 200;
          if (!result.success) {
            const bodyText = Buffer.concat(chunks).toString('utf-8').slice(0, 500);
            result.error = `HTTP ${res.statusCode}: ${bodyText}`;
          }
          resolve(result);
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          result.totalMs = Date.now() - startTime;
          result.error = `Response error: ${err.message}`;
          resolve(result);
        });

        res.on('close', () => {
          // end が先に発火しない場合（例: 切断）
          if (result.totalMs === 0) {
            clearTimeout(timer);
            result.totalMs = Date.now() - startTime;
            if (!result.error) {
              result.error = 'Connection closed unexpectedly';
            }
            resolve(result);
          }
        });
      },
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      result.totalMs = Date.now() - startTime;
      result.error = `Request error: ${err.message}`;
      resolve(result);
    });

    req.on('timeout', () => {
      clearTimeout(timer);
      req.destroy();
      result.totalMs = Date.now() - startTime;
      result.error = 'Socket timeout';
      resolve(result);
    });

    req.write(payload);
    req.end();
  });
}

async function main() {
  log('START', 'OpenCode Go Proxy E2E Test');

  // 1. 認証情報の確認
  const env = {
    ...readEnvFile(['OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL', 'OPENCODE_GO_MODEL']),
    ...Object.fromEntries(
      ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL', 'OPENCODE_GO_MODEL']
        .map((k) => [k, process.env[k]])
        .filter(([, v]) => v),
    ),
  };

  if (!env.OPENCODE_GO_API_KEY) {
    console.error('Error: OPENCODE_GO_API_KEY is not set in .env or environment');
    process.exit(1);
  }

  // 2. provider-config の解決（nanoclaw.yaml or .env から）
  let resolvedConfig;
  try {
    resolvedConfig = resolveProviderConfig();
  } catch (err) {
    console.error('Error resolving provider config:', err);
    process.exit(1);
  }

  // opencode-go を含むプロバイダーを探す
  const opencodeEntry = Object.entries(resolvedConfig.providers).find(
    ([, p]) => p.provider === 'opencode-go',
  );

  if (!opencodeEntry) {
    console.error('Error: No opencode-go provider found in configuration');
    process.exit(1);
  }

  const [providerName, providerConfig] = opencodeEntry;
  log('CONFIG', {
    providerName,
    model: providerConfig.model,
    upstreamBaseURL: providerConfig.upstreamBaseURL,
  });

  // 3. プロキシ起動
  const proxyServer = await startCredentialProxy(0, '127.0.0.1');
  const proxyPort = (proxyServer.address() as AddressInfo).port;
  log('PROXY_STARTED', { port: proxyPort });

  const results: TestResult[] = [];

  try {
    // 4. テストケース実行
    const testCases = [
      { name: 'small-request', payload: buildPayload(1_000), streaming: false },
      { name: 'medium-request', payload: buildPayload(100_000), streaming: false }
    ];

    for (const tc of testCases) {
      log('TEST', tc.name);
      const result = await sendViaProxy(
        proxyPort,
        providerName,
        tc.payload,
        tc.streaming ? 300_000 : 120_000,
      );
      result.name = tc.name;
      results.push(result);
      log('RESULT', result);
      // API レート制限を避けるため少し待つ
      await new Promise((r) => setTimeout(r, 2_000));
    }
  } finally {
    proxyServer.close();
    log('PROXY_STOPPED');
  }

  // 5. サマリー
  console.log('\n========== SUMMARY ==========');
  for (const r of results) {
    const status = r.success ? '✅ PASS' : '❌ FAIL';
    console.log(
      `${status} | ${r.name.padEnd(20)} | req=${r.requestBytes.toString().padStart(8)}B | res=${r.responseBytes.toString().padStart(8)}B | ttfb=${r.ttfbMs.toString().padStart(5)}ms | total=${r.totalMs.toString().padStart(6)}ms | chunks=${r.chunks}`,
    );
    if (r.error) {
      console.log(`       ERROR: ${r.error}`);
    }
  }
  console.log('=============================\n');

  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    console.error(`${failures.length} test(s) failed.`);
    process.exit(1);
  }

  log('DONE', 'All tests passed');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
