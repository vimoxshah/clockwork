/**
 * Run lifecycle FSM states — FR-13. Normative; the daemon's run manager is the
 * only writer of these transitions (ADR-003).
 */
export const RUN_STATES = [
  'scheduled',
  'queued',
  'preparing',
  'running',
  'waiting_approval',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'missed',
  'awaiting_user', // missed-policy 'ask' inbox item
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'missed',
]);

export const isTerminal = (s: RunState): boolean => TERMINAL_STATES.has(s);

/** Outcome reasons for terminal `failed` runs (S-36..S-48 taxonomy). */
export const FAILURE_REASONS = [
  'auth',
  'rate_limited',
  'capacity',
  'offline',
  'repo_invalid',
  'repo_preflight',
  'worktree_error',
  'orphaned',
  'runner_crashed',
  'disk_full',
  'model_unknown',
  'internal',
  'task_disabled',
  'upstream_failed',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * Legal FSM edges. Anything else throws — a state transition outside this map
 * is a programming error, never silently persisted.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  scheduled: ['queued', 'missed', 'cancelled'],
  queued: ['preparing', 'cancelled'],
  preparing: ['running', 'failed', 'cancelled'],
  running: ['waiting_approval', 'finalizing', 'failed', 'cancelled', 'budget_exceeded', 'timed_out'],
  waiting_approval: ['running', 'finalizing', 'failed', 'cancelled', 'timed_out'],
  awaiting_user: ['queued', 'missed', 'cancelled'],
  finalizing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
  timed_out: [],
  missed: [], // re-fire goes through a NEW run row, never mutates a missed run
};

export function assertTransition(from: RunState, to: RunState): void {
  if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Illegal FSM transition: ${from} -> ${to}`);
  }
}
