/**
 * ApiAgentRunner (ADR-028): execution adapter for OpenAI-compatible
 * chat-completions endpoints. Covers OpenAI, OpenRouter, Google (v1beta/openai),
 * Mistral, DeepSeek, xAI, and custom gateways (Ollama/vLLM/LM Studio).
 *
 * The runner is a small agentic loop: system prompt + user prompt → model,
 * streaming tool-call rounds until the model stops or the budget/turn cap hits.
 * Credential is resolved from the BYOK store at run start and injected into the
 * request only — never logged or persisted.
 */
import { writeFileSync } from 'node:fs';

export interface ApiAgentJob {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  maxTurns: number;
  timeoutSec: number;
  onLog?: (line: string) => void;
}

export interface ApiAgentResult {
  ok: boolean;
  output: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

/**
 * Minimal tool-loop. For v1 the agent gets shell + file tools executed in the
 * job's sandboxed worktree via child_process; each round appends tool results.
 */
export async function runApiAgent(job: ApiAgentJob): Promise<ApiAgentResult> {
  const log = job.onLog ?? (() => {});
  const messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
    { role: 'system', content: job.systemPrompt },
    { role: 'user', content: job.prompt },
  ];
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const deadline = Date.now() + job.timeoutSec * 1000;

  try {
    while (turns < job.maxTurns) {
      if (Date.now() > deadline) return { ok: false, output: '', turns, promptTokens, completionTokens, error: 'timed_out' };
      turns += 1;

      const res = await fetch(job.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + job.apiKey },
        body: JSON.stringify({
          model: job.model,
          messages,
          // Tools are exposed but optional; providers without tool support ignore them.
          tools: TOOLS,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(Math.max(30_000, deadline - Date.now())),
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 401 || res.status === 403) return { ok: false, output: body.slice(0, 400), turns, promptTokens, completionTokens, error: 'auth' };
        if (res.status === 429) return { ok: false, output: body.slice(0, 400), turns, promptTokens, completionTokens, error: 'rate_limited' };
        return { ok: false, output: body.slice(0, 400), turns, promptTokens, completionTokens, error: 'provider_error' };
      }
      const data = (await res.json()) as {
        choices: Array<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      promptTokens += data.usage?.prompt_tokens ?? 0;
      completionTokens += data.usage?.completion_tokens ?? 0;

      const choice = data.choices?.[0]?.message;
      if (!choice) return { ok: false, output: '', turns, promptTokens, completionTokens, error: 'empty_response' };

      if (!choice.tool_calls || choice.tool_calls.length === 0) {
        const out = choice.content ?? '';
        log(`[api-agent] done after ${turns} turn(s)`);
        return { ok: true, output: out, turns, promptTokens, completionTokens };
      }

      messages.push(choice as { role: string; content: string | null });
      for (const tc of choice.tool_calls) {
        const result = await execTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'), job.cwd);
        log(`[api-agent] tool ${tc.function.name} → ${result.slice(0, 120).replace(/\n/g, ' ')}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result.slice(0, 12_000) });
      }
    }
    return { ok: false, output: '', turns, promptTokens, completionTokens, error: 'max_turns' };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    return { ok: false, output: '', turns, promptTokens, completionTokens, error: msg.includes('abort') ? 'timed_out' : msg };
  }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace directory. Use for builds, tests, git, and inspection.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text content to a file path relative to the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
];

async function execTool(name: string, args: Record<string, string>, cwd: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  if (name === 'run_command') {
    const command = args.command ?? '';
    try {
      const { stdout } = await run('/bin/bash', ['-c', command], { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      return stdout || '(no output)';
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return `EXIT-ERROR: ${err.stderr ?? err.message ?? 'unknown'}`.slice(0, 6000);
    }
  }
  if (name === 'write_file') {
    const path = await import('node:path');
    const target = path.resolve(cwd, args.path ?? 'untitled.txt');
    if (!target.startsWith(path.resolve(cwd))) return 'ERROR: path escapes workspace';
    writeFileSync(target, args.content ?? '');
    return `wrote ${args.path}`;
  }
  return `ERROR: unknown tool ${name}`;
}
