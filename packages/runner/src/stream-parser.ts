/**
 * Tolerant stream-json parser for headless Claude Code (R-2).
 * Unknown event types are recorded, never thrown on — a user's self-updated
 * CLI may add/change events; the runner must degrade, not die.
 */
import type { UsageSample } from '@clockwork/shared';

export interface ParsedEvent {
  rawType: string;
  sessionId?: string;
  usage?: UsageSample;
  /** final structured summary from a `result` event */
  resultSummary?: string;
  resultSubtype?: string;
  isError?: boolean;
  errorClass?: 'auth' | 'rate_limited' | 'capacity' | 'offline' | 'model_unknown' | 'other';
  errorMessage?: string;
}

export interface StreamParseAccumulator {
  sessionId?: string;
  totalCostUsd: number;
  turns: number;
  lastResult?: string;
  lastError?: { class: ParsedEvent['errorClass']; message: string };
  unknownTypes: string[];
}

export function newAccumulator(): StreamParseAccumulator {
  return { totalCostUsd: 0, turns: 0, unknownTypes: [] };
}

/** Classify an error string into the T-004 taxonomy. */
export function classifyError(msg: string): ParsedEvent['errorClass'] {
  const m = msg.toLowerCase();
  if (m.includes('unauthorized') || m.includes('invalid api key') || m.includes('not logged in') || m.includes('authentication') || m.includes('oauth token')) return 'auth';
  if (m.includes('rate limit') || m.includes('429') || m.includes('too many requests')) return 'rate_limited';
  if (
    m.includes('529') ||
    m.includes('overloaded') ||
    m.includes('capacity') ||
    m.includes('spend limit') ||
    m.includes('weekly limit') ||
    m.includes('usage limit') ||
    m.includes('limit reached')
  )
    return 'capacity';
  if (m.includes('enotfound') || m.includes('econnrefused') || m.includes('fetch failed') || m.includes('network') || m.includes('etimedout')) return 'offline';
  if (m.includes('model') && (m.includes('not found') || m.includes('unknown') || m.includes('deprecat'))) return 'model_unknown';
  return 'other';
}

/**
 * Parse one JSONL line. Returns null for non-JSON lines (CLI chatter).
 */
export function parseStreamLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null; // human-readable stderr noise — caller logs it, we ignore
  }
  const ev: ParsedEvent = { rawType: String(obj?.type ?? 'unknown') };

  switch (obj?.type) {
    case 'system': {
      ev.sessionId = obj.session_id ?? undefined;
      break;
    }
    case 'assistant': {
      ev.sessionId = obj.session_id ?? undefined;
      const usage = obj.message?.usage;
      if (usage) {
        // input+output tokens; cache reads are free-ish but count output toward cost
        ev.usage = {
          costUsd: typeof usage.total_cost_usd === 'number' ? usage.total_cost_usd : estimateUsd(usage),
          turns: 1,
        };
      }
      break;
    }
    case 'user':
      ev.sessionId = obj.session_id ?? undefined;
      break;
    case 'result': {
      ev.resultSubtype = obj.subtype;
      ev.sessionId = obj.session_id ?? undefined;
      ev.isError = Boolean(obj.is_error);
      if (!ev.isError && typeof obj.result === 'string') ev.resultSummary = obj.result;
      if (typeof obj.num_turns === 'number') {
        ev.usage = { costUsd: ev.usage?.costUsd ?? 0, turns: obj.num_turns };
      }
      if (typeof obj.total_cost_usd === 'number') {
        ev.usage = { ...(ev.usage ?? { costUsd: 0, turns: 0 }), costUsd: obj.total_cost_usd };
      }
      if (ev.isError || obj.subtype === 'error_during_execution' || obj.subtype === 'error_max_turns') {
        const msg = String(obj.result ?? obj.error ?? 'execution error');
        ev.errorMessage = msg;
        ev.errorClass = classifyError(msg);
      }
      break;
    }
    default:
      break;
  }
  return ev;
}

function estimateUsd(usage: Record<string, number>): number {
  // Fallback when the CLI doesn't emit dollar figures (subscription mode):
  // rough Sonnet-class estimate so budget meters still move.
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (inTok * 3 + outTok * 15) / 1_000_000;
}

/** Fold one parsed event into the accumulator; returns usage delta or null. */
export function fold(acc: StreamParseAccumulator, ev: ParsedEvent): UsageSample | null {
  if (ev.rawType === 'unknown' && !acc.unknownTypes.includes(ev.rawType)) acc.unknownTypes.push(ev.rawType);
  if (ev.sessionId) acc.sessionId = ev.sessionId;
  if (ev.errorMessage && ev.errorClass) acc.lastError = { class: ev.errorClass, message: ev.errorMessage };
  if (ev.resultSummary) acc.lastResult = ev.resultSummary;

  if (ev.usage) {
    if (typeof ev.usage.costUsd === 'number' && ev.usage.costUsd > acc.totalCostUsd) {
      // `total_cost_usd` is cumulative; per-message events are additive.
      acc.totalCostUsd = ev.usage.costUsd;
    } else if (typeof ev.usage.costUsd === 'number') {
      acc.totalCostUsd += ev.usage.costUsd;
    }
    if (typeof ev.usage.turns === 'number' && ev.rawType === 'assistant') acc.turns += ev.usage.turns;
    else if (typeof ev.usage.turns === 'number') acc.turns = Math.max(acc.turns, ev.usage.turns);
    return { costUsd: acc.totalCostUsd, turns: acc.turns };
  }
  return null;
}
