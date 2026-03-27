/**
 * セットアップステップ用の構造化されたステータスブロック出力。
 * 各ステップは SKILL.md の LLM がパース可能なブロックを出力します。
 */

export function emitStatus(
  step: string,
  fields: Record<string, string | number | boolean>,
): void {
  const lines = [`=== NANOCLAW SETUP: ${step} ===`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}
