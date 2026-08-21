/**
 * Context assembly (FR-2a): live-reference file attachments are read at
 * execution time by the runner child and appended as bounded excerpts.
 * Credential-path attachments are refused via the same floor as runtime reads
 * (S-55/S-67); oversized files truncate with an honest marker.
 */
import { readFileSync, statSync } from 'node:fs';
import { evaluatePathRead } from './deny-list.js';

export interface Attachment {
  path: string;
  mode?: string;
}

export interface ContextResult {
  block: string;
  included: string[];
  refused: string[];
  truncatedFiles: string[];
}

const PER_FILE_BUDGET = 8_000;
const MAX_FILES = 12;

export function assembleContext(attachments: Attachment[]): ContextResult {
  const included: string[] = [];
  const refused: string[] = [];
  const truncatedFiles: string[] = [];
  const parts: string[] = [];

  for (const att of attachments.slice(0, MAX_FILES)) {
    const verdict = evaluatePathRead(att.path);
    if (verdict.floor || verdict.denied) {
      refused.push(`${att.path}: ${verdict.reason ?? 'denied'}`);
      continue;
    }
    try {
      const stat = statSync(att.path);
      if (!stat.isFile()) {
        refused.push(`${att.path}: not a regular file`);
        continue;
      }
      const raw = readFileSync(att.path, 'utf8');
      const clipped =
        raw.length > PER_FILE_BUDGET
          ? `${raw.slice(0, PER_FILE_BUDGET)}\n… [truncated ${raw.length - PER_FILE_BUDGET} chars]`
          : raw;
      if (raw.length > PER_FILE_BUDGET) truncatedFiles.push(att.path);
      parts.push(`--- Attached file: ${att.path} ---\n${clipped}\n`);
      included.push(att.path);
    } catch (e) {
      refused.push(`${att.path}: unreadable (${String(e).slice(0, 80)})`);
    }
  }

  const block =
    parts.length > 0
      ? `\n\n# Clockwork attached context\n\n${parts.join('\n')}`
      : '';
  return { block, included, refused, truncatedFiles };
}

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /AKIA[0-9A-Z]{16}/g, label: '[AWS-KEY-MASKED]' },
  { re: /ghp_[A-Za-z0-9]{36}/g, label: '[GITHUB-TOKEN-MASKED]' },
  { re: /github_pat_[A-Za-z0-9_]{40,}/g, label: '[GITHUB-PAT-MASKED]' },
  { re: /sk-ant-[A-Za-z0-9-]{20,}/g, label: '[ANTHROPIC-KEY-MASKED]' },
  { re: /sk-[A-Za-z0-9]{32,}/g, label: '[API-KEY-MASKED]' },
  { re: /xox[bap]-[A-Za-z0-9-]{10,}/g, label: '[SLACK-TOKEN-MASKED]' },
  { re: /(password|passwd|secret|token)\s*[=:]\s*\S+/gi, label: '$1=[MASKED]' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: '[PEM-BLOCK-MASKED]' },
];

/** S-68: best-effort masking of common credential patterns in report text. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.label);
  return out;
}
