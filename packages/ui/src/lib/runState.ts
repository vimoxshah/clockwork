/**
 * How a run's state is shown — its chip colour and its NAME.
 *
 * `chipFor` lived twice, byte-identical, in InboxView and CalendarView. Two
 * copies of a colour mapping is how the Inbox and the Calendar end up
 * disagreeing about what "missed" looks like, so it lives once now.
 *
 * `stateLabel` is the other half, and it is the fix for a real complaint. Every
 * one of these surfaces rendered the daemon's own enum straight to screen —
 * `completed`, `failed`, `waiting_approval` — so the product spoke to people in
 * lower-case identifiers. The state VALUE is a wire contract and never changes
 * (`data-testid={`run-${state}`}` and every filter still key off it); only the
 * rendered text does.
 */

/** The `.chip` modifier class for a run state, or '' when it has no colour. */
export function chipFor(state: string): string {
  if (state === 'completed') return 'completed';
  if (['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state)) return 'failed';
  if (['running', 'queued', 'preparing', 'finalizing'].includes(state)) return 'running';
  if (['waiting_approval', 'awaiting_user'].includes(state)) return 'needs-you';
  return '';
}

/**
 * Names that read as English rather than as enum members. Anything not listed
 * falls back to underscores-to-spaces plus a capital, so a state added to the
 * daemon tomorrow still renders sensibly instead of vanishing.
 */
const LABELS: Record<string, string> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  missed: 'Missed',
  running: 'Running',
  queued: 'Queued',
  preparing: 'Preparing',
  finalizing: 'Finalizing',
  timed_out: 'Timed out',
  budget_exceeded: 'Over budget',
  waiting_approval: 'Waiting for you',
  awaiting_user: 'Waiting for you',
};

export function stateLabel(state: string | undefined | null): string {
  if (!state) return '';
  const known = LABELS[state];
  if (known) return known;
  const spaced = state.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
