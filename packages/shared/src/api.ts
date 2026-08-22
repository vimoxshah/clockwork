import { z } from 'zod';
import type { RunState } from './states.js';

/** API version handshake (S-61): UI and daemon negotiate before use. */
export const API_VERSION = 1;

export const Health = z.object({
  ok: z.boolean(),
  apiVersion: z.number(),
  daemonVersion: z.string(),
  paused: z.boolean(),
  activeRuns: z.number(),
  queuedRuns: z.number(),
  nextFire: z.number().nullable(),
});
export type Health = z.infer<typeof Health>;

/** SSE event envelope (arch §6). */
export const SseEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.state_changed'), runId: z.string(), taskId: z.string(), state: z.custom<RunState>(() => true), at: z.number() }),
  z.object({ type: z.literal('approval.requested'), approvalId: z.string(), runId: z.string(), at: z.number() }),
  z.object({ type: z.literal('report.ready'), runId: z.string(), at: z.number() }),
  z.object({ type: z.literal('daemon.health'), data: Health, at: z.number() }),
]);
export type SseEvent = z.infer<typeof SseEvent>;

/** Task row as returned by the API (never raw internal rows). */
export const TaskView = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  profileId: z.string().nullable(),
  repoPath: z.string().nullable(),
  baseBranch: z.string().nullable(),
  model: z.string().nullable(),
  permissionMode: z.string(),
  engine: z.string().nullable(),
  budget: z.object({ maxUsd: z.number(), maxTurns: z.number(), timeoutSec: z.number() }),
  schedule: z.unknown(),
  overlapPolicy: z.string(),
  missedPolicy: z.string(),
  missedWindowSec: z.number(),
  retryOnTransient: z.boolean(),
  enabled: z.boolean(),
  version: z.number(),
  nextFire: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TaskView = z.infer<typeof TaskView>;

export const SearchHit = z.object({
  kind: z.enum(['task', 'run', 'template', 'profile', 'approval']),
  refId: z.string(),
  title: z.string(),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;
