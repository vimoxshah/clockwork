/**
 * Composer (T-123) — redesigned on the shadcn-pattern primitive set:
 * sectioned card layout, persona profile cards, segmented schedule control,
 * themed DateTimePicker, inline validation. Logic identical to v1.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ComposerPrefill } from './CalendarView';
import { Button } from './ui/button';
import { Input, Textarea, Label } from './ui/input';
import { Card, CardContent } from './ui/card';
import { Segmented } from './ui/segmented';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Switch } from './ui/switch';
import { AgentPicker } from './AgentPicker';
import { DateTimePicker } from './ui/datetime-picker';
import { Badge } from './ui/card';
import { Zap, FolderGit2, Bot, Wallet, CalendarClock, AlertCircle, GitBranch, Bell, Send } from 'lucide-react';
import { cn } from '../lib/cn';
import { FolderBrowserDialog } from './FolderBrowserDialog';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * The RRULE/cron picker lives here, not on the calendar (which only
 * DISPLAYS the occurrences a schedule produces — it has no control that
 * writes a schedule). This is the only screen that actually builds one.
 */
export const SCHEDULING_SURFACE = registerFeatureSurface({
  key: 'scheduling',
  tab: 'new',
  where: 'New task › Schedule',
  anchorId: 'schedule-section',
});

/**
 * The per-task budget cap (`maxUsd`/`maxTurns`/`timeoutSec`) is what
 * run-manager.ts actually enforces as a hard stop mid-run — this section is
 * where it is set at creation time (TasksView's EditDialog is the other
 * writer, for an existing task).
 */
export const BUDGET_GUARDS_SURFACE = registerFeatureSurface({
  key: 'budget_guards',
  tab: 'new',
  where: 'New task › Budget & limits',
  anchorId: 'budget-guards',
});


/**
 * How far ahead an ASAP booking is placed. `POST /tasks` refuses a `once`
 * schedule whose `runAt` is already behind `Date.now()` at validation time, and
 * the clock moves while the request is in flight, so "now" cannot be sent
 * literally. Small enough that ASAP still means ASAP: the 30s scheduler sweep
 * dominates the wait either way.
 */
const ASAP_LEAD_MS = 15_000;

function defaultSlot(): Date {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  return d;
}

/**
 * Assemble the task's `delivery` object (DeliveryConfig, packages/shared/src/schemas.ts)
 * from the composer's per-task delivery fields. Exported (pure, no component
 * state) so the "unchanged when blank" and group allow-list rules are
 * unit-testable without mounting the composer.
 *
 * - Nothing filled in: sends exactly `{ osNotify: true }` — the object shipped
 *   before per-task delivery existed, so existing behaviour is unchanged.
 * - A chat id in a non-group chat: no allow-list needed — there's only one
 *   person on the other end.
 * - A chat id marked as a group: always attaches `allowedUserIds`, even when
 *   the list is empty. An empty list in a group is the honest "refuse every
 *   press" state (ADR-036), not an unset one, so it must be sent, not omitted.
 * - Slack carries no URL: the incoming-webhook URL is the credential and lives
 *   in Settings, so the task row only holds the opt-in.
 * - Email carries recipients only, for the same reason — the relay password is
 *   a credential and stays in Settings.
 *
 * `extra` is a fourth, optional parameter rather than three more positional
 * ones so the existing three-argument call sites and tests read unchanged.
 */
export function buildTaskDelivery(
  chatIdRaw: string,
  isGroup: boolean,
  allowedUserIdsRaw: string,
  extra: { slack?: boolean; emailToRaw?: string } = {},
): Record<string, unknown> {
  const chatId = chatIdRaw.trim();
  const emailTo = (extra.emailToRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const delivery: Record<string, unknown> = { osNotify: true };
  if (chatId) {
    delivery.telegram = {
      chatId,
      ...(isGroup
        ? {
            allowedUserIds: allowedUserIdsRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
    };
  }
  if (extra.slack) delivery.slack = { enabled: true };
  if (emailTo.length > 0) delivery.email = { to: emailTo };
  return delivery;
}

interface ProfileRow {
  id: string;
  slug: string;
  name: string;
  color?: string | null;
  avatar?: string | null;
}

const DOW = [
  { value: 'MO', label: 'Mon' },
  { value: 'TU', label: 'Tue' },
  { value: 'WE', label: 'Wed' },
  { value: 'TH', label: 'Thu' },
  { value: 'FR', label: 'Fri' },
  { value: 'SA', label: 'Sat' },
  { value: 'SU', label: 'Sun' },
];

function Section({
  n,
  icon,
  title,
  id,
  children,
}: {
  n?: string;
  icon: React.ReactNode;
  title: string;
  id?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section id={id}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-active text-dim [&_svg]:h-3.5 [&_svg]:w-3.5">
          {icon}
        </span>
        <h3 className="text-compact font-semibold text-fg">{title}</h3>
        {n && <span className="rounded-full bg-surface-active px-1.5 text-xxs text-dim">{n}</span>}
      </div>
      {children}
    </section>
  );
}

export default function ComposerView({
  onDone,
  prefill,
}: {
  onDone: () => void;
  prefill: ComposerPrefill | null;
}): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [providers, setProviders] = useState<Array<{ id: string; label: string; detected: boolean; version: string | null }>>([]);
  const [byokConfigs, setByokConfigs] = useState<Array<{ id: string; label: string; default_model: string; model_label?: string; is_default?: boolean; last_error: string | null }>>([]);
  const defaultByok = byokConfigs.find((b) => b.is_default);
  const [form, setForm] = useState(() => ({
    name: '',
    prompt: '',
    repoPath: '',
    profileId: '',
    providerId: 'claude',
    byokId: '',
    chainAfter: '',
    permissionMode: 'acceptEdits' as 'plan' | 'acceptEdits',
    maxUsd: '2',
    maxTurns: '50',
    timeoutSec: '3600',
    // 'asap' is a COMPOSER kind, not a daemon one. It saves as a `once`
    // schedule a few seconds out; see `submit`. The daemon's own 'queue' kind
    // is a different thing — the review gate for imported tasks, plan-execute
    // and repo-jobs — and this option used to reuse it, which is why an "ASAP"
    // task never ran.
    kind: 'once' as 'once' | 'rrule' | 'asap',
    runAt: prefill ? new Date(prefill.runAtLocal) : defaultSlot(),
    rruleFreq: 'WEEKLY' as 'DAILY' | 'WEEKLY' | 'MONTHLY',
    rruleByDay: 'MO',
    rruleTime: '09:00',
    monthlyDay: String(new Date().getDate()),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    telegramChatId: '',
    telegramIsGroup: false,
    telegramAllowedUserIds: '',
    slackEnabled: false,
    emailTo: '',
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);

  useEffect(() => {
    void api.profiles().then(setProfiles).catch(() => {});
    void api.providers().then(setProviders).catch(() => {});
    void api.byok().then((b) => setByokConfigs((b as { configs: Array<{ id: string; label: string; default_model: string; last_error: string | null }> }).configs ?? [])).catch(() => {});
  }, []);

  // Calendar "Book a run this day" prefill arrives after mount.
  useEffect(() => {
    if (prefill?.runAtLocal) {
      setForm((f) => ({ ...f, kind: 'once', runAt: new Date(prefill.runAtLocal) }));
    }
  }, [prefill]);

  const selectedProfile = profiles.find((p) => p.id === form.profileId) ?? null;
  const detectedProviders = providers.filter((p) => p.detected);
  const providerOptions = [
    ...(detectedProviders.length > 0
      ? detectedProviders
      : providers
    ).map((p) => ({
      value: p.id === 'cli' ? 'claude' : p.id,
      label: p.label,
      title: p.version ?? 'not installed',
    })),
  ];
  const activeProvider = providers.find(
    (p) => (p.id === 'cli' ? 'claude' : p.id) === form.providerId,
  );

  const submit = async (): Promise<void> => {
    setError(null);
    const maxUsdN = Number(form.maxUsd);
    const maxTurnsN = Number(form.maxTurns);
    const timeoutSecN = Number(form.timeoutSec);
    if (!form.prompt.trim()) return setError('A prompt is required.');
    if (!Number.isFinite(maxUsdN) || maxUsdN <= 0) return setError('Budget must be a positive number.');
    if (!Number.isInteger(maxTurnsN) || maxTurnsN < 1) return setError('Max turns must be a positive integer.');
    if (!Number.isInteger(timeoutSecN) || timeoutSecN < 30) return setError('Timeout must be at least 30 seconds.');

    let schedule: Record<string, unknown>;
    if (form.kind === 'once') {
      schedule = { kind: 'once', runAt: form.runAt.getTime(), tz: form.tz };
    } else if (form.kind === 'asap') {
      // A `queue`-kind row is stored `enabled=0, next_fire=NULL` (repo.ts), so
      // `Scheduler.tick` — which needs `enabled=1 AND next_fire IS NOT NULL` —
      // could never fire it, and the calendar skips the kind outright. "ASAP"
      // therefore sat on the tray forever and only ran when a human pressed
      // run. A near-future `once` fires on the next 30s sweep, joins the
      // run-manager's slot queue, and shows up on the calendar.
      //
      // The lead is not slack: /tasks rejects `runAt` already in the past, and
      // the clock moves between building this payload and validating it.
      schedule = { kind: 'once', runAt: Date.now() + ASAP_LEAD_MS, tz: form.tz };
    } else {
      const [hh, mm] = form.rruleTime.split(':').map(Number);
      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return setError('Pick a valid recurrence time.');
      let rrule: string;
      if (form.rruleFreq === 'DAILY') rrule = `FREQ=DAILY;BYHOUR=${hh};BYMINUTE=${mm}`;
      else if (form.rruleFreq === 'WEEKLY') rrule = `FREQ=WEEKLY;BYDAY=${form.rruleByDay};BYHOUR=${hh};BYMINUTE=${mm}`;
      else {
        const dom = Number(form.monthlyDay);
        if (!Number.isInteger(dom) || dom < 1 || dom > 28)
          return setError('Monthly day must be 1–28 (safe across months).');
        rrule = `FREQ=MONTHLY;BYMONTHDAY=${dom};BYHOUR=${hh};BYMINUTE=${mm}`;
      }
      schedule = { kind: 'rrule', rrule, tz: form.tz };
    }

    const delivery = buildTaskDelivery(form.telegramChatId, form.telegramIsGroup, form.telegramAllowedUserIds, {
      slack: form.slackEnabled,
      emailToRaw: form.emailTo,
    });

    setBusy(true);
    try {
      const engine = form.providerId === 'claude' ? 'cli' : form.providerId;
      const byok = byokConfigs.find((b) => b.id === form.byokId);
      await api.createTask({
        name: form.name.trim() || 'Untitled task',
        prompt: form.prompt,
        repoPath: form.repoPath.trim() || undefined,
        profileId: form.profileId || undefined,
        permissionMode: form.permissionMode,
        budget: { maxUsd: maxUsdN, maxTurns: maxTurnsN, timeoutSec: timeoutSecN },
        missedPolicy: 'run-late',
        overlapPolicy: 'skip',
        retryOnTransient: false,
        context: { files: [] },
        delivery,
        schedule,
        engine: engine as 'cli',
        byokId: form.byokId || undefined,
        model: byok?.default_model ?? undefined,
      });
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const doClone = async (): Promise<void> => {
    setCloneBusy(true);
    setError(null);
    try {
      const r = await api.cloneRepo(cloneUrl.trim());
      setForm((f) => ({ ...f, repoPath: r.path }));
      setCloneOpen(false);
      setCloneUrl('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setCloneBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-8">
      <Card>
        {browsing && (
          <FolderBrowserDialog
            open={browsing}
            onClose={() => setBrowsing(false)}
            onPick={(p) => setForm((f) => ({ ...f, repoPath: p }))}
          />
        )}
        <Dialog open={cloneOpen} onOpenChange={(o) => !o && setCloneOpen(false)}>
          <DialogContent>
            <DialogTitle>Clone a git repository</DialogTitle>
            <DialogDescription>
              Shallow-cloned into ~/.clockwork/repos/ and selected for this task.
            </DialogDescription>
            <div className="mt-3 space-y-2">
              <Input
                placeholder="https://github.com/you/repo.git"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                className="mono"
                onKeyDown={(e) => e.key === 'Enter' && void doClone()}
              />
              {error?.includes('clone') && <div className="error-banner">{error}</div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCloneOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!cloneUrl.trim() || cloneBusy} onClick={() => void doClone()}>
                {cloneBusy ? 'Cloning…' : 'Clone'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-accent" />
            <h2 className="text-base font-semibold">Book a run</h2>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            Define the job once — Clockwork fires it in an isolated worktree and files a report.
          </p>
        </div>

        <CardContent className="grid gap-6 p-5 lg:grid-cols-5">
          {/* ---------- main column ---------- */}
          <div className="space-y-6 lg:col-span-3">
            <Section icon={<Bot />} title="The job">
              <Label htmlFor="c-name">Task name</Label>
              <Input
                id="c-name"
                placeholder="Nightly TODO digest"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Label className="mt-4" htmlFor="c-prompt">
                Prompt
              </Label>
              <Textarea
                id="c-prompt"
                data-testid="prompt"
                className="min-h-[110px]"
                placeholder="What should the agent do? Be specific about scope and what done looks like."
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            </Section>

            <Section icon={<FolderGit2 />} title="Repository">
              <Label htmlFor="c-repo">Repo path</Label>
              <div className="flex gap-2">
                <Input
                  id="c-repo"
                  placeholder="/Users/you/dev/my-repo"
                  value={form.repoPath}
                  onChange={(e) => setForm({ ...form, repoPath: e.target.value })}
                />
                <Button variant="outline" onClick={() => setBrowsing(true)} title="Browse folders">
                  Browse
                </Button>
                <Button variant="outline" onClick={() => setCloneOpen(true)} title="Clone from a git URL">
                  <GitBranch /> Clone URL
                </Button>
              </div>
              {form.repoPath && form.repoPath.startsWith(`${process.env.HOME ?? '~'}/.clockwork/repos/`) && (
                <p className="mt-1 text-xs text-info">✓ cloned & managed by Clockwork</p>
              )}
              {!form.repoPath && <p className="mt-1 text-xs text-dim">Empty = scratch task (no git isolation).</p>}
            </Section>

            <Section icon={<Bot />} title="Provider">
              <Segmented
                aria-label="Provider"
                className="w-full"
                value={form.providerId}
                onChange={(v) => setForm({ ...form, providerId: v })}
                options={providerOptions}
              />
              {activeProvider && (
                <p className="mt-1 text-xs text-dim">
                  {activeProvider.detected
                    ? `${activeProvider.label} · ${activeProvider.version}`
                    : `${activeProvider.label} not installed`}
                </p>
              )}
              {byokConfigs.length > 0 && (
                <div className="mt-2">
                  <Label>…or use an API provider (BYOK)</Label>
                  <Select
                    value={form.byokId || '__engine__'}
                    onValueChange={(v) => setForm({ ...form, byokId: v === '__engine__' ? '' : v })}
                  >
                    <SelectTrigger aria-label="API provider (BYOK)" data-testid="composer-byok-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__engine__">
                        Engine above{defaultByok ? ` · or pick ${defaultByok.label} below (default)` : ' — no API key needed'}
                      </SelectItem>
                      {byokConfigs.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.label}{b.is_default ? ' (default)' : ''} · {b.model_label ?? b.default_model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {byokConfigs.find((b) => b.id === form.byokId) && (
                    <p className="mt-1 text-xs text-dim">
                      Runs via API with your key (billed to your provider account, separate from any subscription). Configure keys in Settings → API providers.
                    </p>
                  )}
                </div>
              )}
              {profiles.length > 1 && (
                <div className="mt-2">
                  <Label>Chain after (optional)</Label>
                  <Select
                    value={form.chainAfter || '__independent__'}
                    onValueChange={(v) => setForm({ ...form, chainAfter: v === '__independent__' ? '' : v })}
                  >
                    <SelectTrigger aria-label="Chain after task">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__independent__">— run independently —</SelectItem>
                      {profiles
                        .filter((p) => p.id !== form.profileId)
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            After profile: {p.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-dim">
                    Chained tasks wait for the upstream task to finish, then run with its report injected via {'{{previous.report}}'}.
                  </p>
                </div>
              )}
            </Section>

            <Section icon={<Wallet />} title="Budget & limits" id={BUDGET_GUARDS_SURFACE.anchorId}>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="c-usd">USD soft cap</Label>
                  <Input
                    id="c-usd"
                    className="mono"
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={form.maxUsd}
                    onChange={(e) => setForm({ ...form, maxUsd: e.target.value })}
                  />
                  <p className="mt-1 text-xxs text-dim">stops between messages</p>
                </div>
                <div>
                  <Label htmlFor="c-turns">Max turns</Label>
                  <Input
                    id="c-turns"
                    className="mono"
                    type="number"
                    min={1}
                    value={form.maxTurns}
                    onChange={(e) => setForm({ ...form, maxTurns: e.target.value })}
                  />
                  <p className="mt-1 text-xxs text-dim">hard bound</p>
                </div>
                <div>
                  <Label htmlFor="c-timeout">Timeout s</Label>
                  <Input
                    id="c-timeout"
                    className="mono"
                    type="number"
                    min={30}
                    value={form.timeoutSec}
                    onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })}
                  />
                  <p className="mt-1 text-xxs text-dim">hard bound</p>
                </div>
              </div>
            </Section>
          </div>

          {/* ---------- side column ---------- */}
          <div className="space-y-6 lg:col-span-2">
            <section>
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-active text-dim [&_svg]:h-3.5 [&_svg]:w-3.5">
                  <Bot />
                </span>
                <h3 className="text-compact font-semibold">Agent profile</h3>
              </div>
              <div role="radiogroup" aria-label="Agent profile" className="space-y-2">
                <PersonaCard
                  selected={!form.profileId}
                  onSelect={() => setForm({ ...form, profileId: '' })}
                  glyph="◦"
                  color="#9ba1b6"
                  name="Generalist"
                  slug={null}
                  description="Balanced defaults for any repo chore."
                />
              </div>
              <div className="mt-2">
                <AgentPicker
                  profiles={profiles.map((p) => ({ id: p.id, name: p.name, slug: p.slug ?? null, avatar: p.avatar ?? null, color: p.color ?? null }))}
                  value={form.profileId}
                  onChange={(id) => setForm({ ...form, profileId: id })}
                />
              </div>
              {selectedProfile === null ? null : null}            </section>

            <section>
              <Label>Permission mode</Label>
              <Segmented
                aria-label="Permission mode"
                className="w-full"
                value={form.permissionMode}
                onChange={(v) => setForm({ ...form, permissionMode: v })}
                options={[
                  { value: 'plan', label: 'plan (dry-run)', title: 'Read-only dry run — no edits land' },
                  { value: 'acceptEdits', label: 'acceptEdits' },
                ]}
              />
            </section>

            <section id={SCHEDULING_SURFACE.anchorId}>
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-active text-dim [&_svg]:h-3.5 [&_svg]:w-3.5">
                  <CalendarClock />
                </span>
                <h3 className="text-compact font-semibold">Schedule</h3>
              </div>
              <Segmented
                aria-label="Schedule type"
                className="w-full"
                value={form.kind}
                onChange={(v) => setForm({ ...form, kind: v })}
                options={[
                  { value: 'once', label: 'One-off' },
                  { value: 'rrule', label: 'Recurring' },
                  { value: 'asap', label: 'ASAP', title: 'Start on the next sweep, then wait only for a free slot' },
                ]}
              />

              <div className="mt-3 rounded-lg border border-border bg-bg p-3">
                {form.kind === 'once' && (
                  <>
                    <Label htmlFor="c-when">Run at</Label>
                    <DateTimePicker
                      id="c-when"
                      value={form.runAt}
                      onChange={(d) => setForm({ ...form, runAt: d })}
                    />
                    <p className="mt-2 text-xs text-dim">
                      {form.runAt.getTime() < Date.now()
                        ? '⚠ This time is in the past — pick a future slot.'
                        : `Fires ${form.runAt.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${form.tz}).`}
                    </p>
                  </>
                )}
                {form.kind === 'rrule' && (
                  <div className="space-y-3">
                    <Segmented
                      aria-label="Repeat frequency"
                      size="sm"
                      className="w-full"
                      value={form.rruleFreq}
                      onChange={(v) => setForm({ ...form, rruleFreq: v })}
                      options={[
                        { value: 'DAILY', label: 'Daily' },
                        { value: 'WEEKLY', label: 'Weekly' },
                        { value: 'MONTHLY', label: 'Monthly' },
                      ]}
                    />
                    {form.rruleFreq === 'WEEKLY' && (
                      <div>
                        <Label>On</Label>
                        <div className="flex gap-1">
                          {DOW.map((d) => (
                            <button
                              key={d.value}
                              onClick={() => setForm({ ...form, rruleByDay: d.value })}
                              aria-pressed={form.rruleByDay === d.value}
                              className={cn(
                                'h-8 w-full rounded-md border text-xxs font-medium',
                                form.rruleByDay === d.value
                                  ? 'border-accent bg-accent text-[var(--accent-fg)]'
                                  : 'border-border text-muted hover:bg-surface-hover hover:text-fg',
                              )}
                            >
                              {d.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {form.rruleFreq === 'MONTHLY' && (
                      <div>
                        <Label htmlFor="c-dom">On day of month (1–28)</Label>
                        <Input
                          id="c-dom"
                          className="mono w-24"
                          type="number"
                          min={1}
                          max={28}
                          value={form.monthlyDay}
                          onChange={(e) => setForm({ ...form, monthlyDay: e.target.value })}
                        />
                      </div>
                    )}
                    <div>
                      <Label htmlFor="c-rtime">At time</Label>
                      <input
                        id="c-rtime"
                        type="time"
                        className="mono h-9 w-32 rounded-lg border border-strong bg-bg px-3 text-compact text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        value={form.rruleTime}
                        onChange={(e) => setForm({ ...form, rruleTime: e.target.value })}
                      />
                    </div>
                  </div>
                )}
                {form.kind === 'asap' && (
                  <div className="flex items-start gap-2 text-xs text-muted">
                    <Badge variant="info">ASAP</Badge>
                    Books a one-off for the next scheduler sweep (within 30s), then starts as soon as a
                    concurrency slot <em>and</em> its repo are free — position shown in the Tasks queue lane.
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-active text-dim [&_svg]:h-3.5 [&_svg]:w-3.5">
                  <Bell />
                </span>
                <h3 className="text-compact font-semibold">Telegram approvals (optional)</h3>
              </div>
              <p className="mb-2 text-xs text-dim">
                When this run waits for your OK, Clockwork messages this chat so you can approve or
                deny right from Telegram — no need to open the app. Set your bot token once in
                Settings → Notifications &amp; delivery.
              </p>
              <Label htmlFor="c-telegram-chat">Telegram chat id</Label>
              <Input
                id="c-telegram-chat"
                placeholder="e.g. 123456789"
                value={form.telegramChatId}
                onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })}
              />
              {form.telegramChatId.trim() && (
                <div className="mt-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="c-telegram-group"
                      checked={form.telegramIsGroup}
                      onCheckedChange={(v) => setForm({ ...form, telegramIsGroup: v })}
                    />
                    <Label htmlFor="c-telegram-group" className="mb-0">
                      This is a group chat
                    </Label>
                  </div>
                  {form.telegramIsGroup && (
                    <div className="mt-2">
                      <Label htmlFor="c-telegram-allowed">Allowed Telegram user ids (comma-separated)</Label>
                      <Input
                        id="c-telegram-allowed"
                        placeholder="111111111, 222222222"
                        value={form.telegramAllowedUserIds}
                        onChange={(e) => setForm({ ...form, telegramAllowedUserIds: e.target.value })}
                      />
                      <p className="mt-1 text-xxs text-dim">
                        In a group chat, only these Telegram user ids may approve or deny — anyone
                        else's press is refused. Leave this empty and every press is refused, for
                        everyone in the group.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/*
              A separate section from Telegram approvals on purpose — but the
              reason inverted. Both sections now receive the approval REQUEST:
              run-manager.ts fans it out through the shared deliverApproval, so
              the channel list is the one the run REPORT already used. What
              Telegram alone carries is the DECISION — approve/deny buttons
              behind an inbound poller. Slack and email can only point at the
              Inbox, so heading this section "approvals" is still the
              overclaim, the other way round: it would promise an answer path
              that is not there.

              Neither field takes a URL or a password. A Slack incoming-webhook
              URL and an SMTP relay password are credentials, so they live in
              Settings and never in a task row (DeliveryConfig, schemas.ts).
            */}
            <section>
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-active text-dim [&_svg]:h-3.5 [&_svg]:w-3.5">
                  <Send />
                </span>
                <h3 className="text-compact font-semibold">Slack and email (optional)</h3>
              </div>
              {/* The decision sentence sits unwrapped on its own source line so
                  the honesty guard in delivery-channels-ui.test.tsx can pin the
                  whole sentence instead of a fragment. JSX joins two adjacent
                  text lines with a single space, so the paragraph still reads
                  as one — the test asserts that on the DOM as well. */}
              <p className="mb-2 text-xs text-dim">
                Where the outcome goes when this task finishes — and where a notice goes if the run
                stops to ask for your OK.
                Approving or denying still happens in this app or in Telegram.
              </p>
              <div className="flex items-center gap-2">
                <Switch
                  id="c-slack"
                  checked={form.slackEnabled}
                  onCheckedChange={(v) => setForm({ ...form, slackEnabled: v })}
                />
                <Label htmlFor="c-slack" className="mb-0">
                  Post to Slack
                </Label>
              </div>
              <p className="mt-1 text-xxs text-dim">
                Uses the workspace webhook from Settings → Notifications &amp; delivery. One webhook
                posts to one channel, so every task that opts in posts to that same channel.
              </p>
              <Label htmlFor="c-email-to" style={{ marginTop: 10 }}>
                Email to (comma-separated)
              </Label>
              <Input
                id="c-email-to"
                placeholder="dana@example.com, marcus@example.com"
                value={form.emailTo}
                onChange={(e) => setForm({ ...form, emailTo: e.target.value })}
              />
              <p className="mt-1 text-xxs text-dim">
                Plain text, sent through the SMTP relay in Settings. Up to 20 recipients.
              </p>
            </section>
          </div>
        </CardContent>

        {/* ---------- footer ---------- */}
        <div className="border-t border-border px-5 py-3">
          {error && (
            <div className="error-banner" role="alert" data-testid="composer-error">
              <span className="inline-flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" /> {error}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between">
            <p className="text-xs text-dim">
              ⏾ Runs fire when this Mac is awake — keep-awake is armed when plugged in.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onDone} disabled={busy}>
                Cancel
              </Button>
              <Button disabled={busy || !form.prompt.trim()} onClick={() => void submit()}>
                {busy ? 'Booking…' : 'Book it'}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function PersonaCard({
  selected,
  onSelect,
  glyph,
  color,
  name,
  slug,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  glyph: string;
  color: string;
  name: string;
  slug: string | null;
  description?: string;
}): JSX.Element {
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        selected
          ? 'border-accent bg-surface-hover ring-1 ring-inset ring-accent'
          : 'border-border bg-bg hover:border-strong hover:bg-surface-hover',
      )}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        style={{ backgroundColor: `${color}22`, color }}
        aria-hidden
      >
        {glyph}
      </span>
      <span className="min-w-0">
        <span className="block text-compact font-medium text-fg">{name}</span>
        <span className="block truncate text-xs text-dim">
          {slug ? `@${slug}` : description ?? 'Default profile'}
        </span>
      </span>
    </button>
  );
}

