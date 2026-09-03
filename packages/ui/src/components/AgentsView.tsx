/**
 * Agents (FR-28 full / T-209): explains every profile in plain language and
 * lets users create their own — name, glyph, color, system prompt, budget
 * defaults. Built-ins are explained; custom profiles are fully functional.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { Card, CardContent, Badge } from './ui/card';
import { Button } from './ui/button';
import { Input, Textarea, Label } from './ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { Plus, Sparkles } from 'lucide-react';

const BUILTIN_EXPLAIN: Record<string, { what: string; use: string }> = {
  generalist: {
    what: 'Balanced persona for any repo chore: reads context first, makes careful edits, writes a clear summary.',
    use: 'Default choice when you just need a capable pair of hands on a schedule.',
  },
  'dep-surgeon': {
    what: 'Conservative dependency hygiene — patch/minor bumps only when tests prove them; majors get triage notes, never blind upgrades. Never pushes or publishes.',
    use: 'Weekly “update deps safely” jobs on active repos.',
  },
  'docs-scribe': {
    what: 'Documentation hygiene from evidence in the repo: fixes drift, keeps voice, never invents features. One commit per run.',
    use: 'Friday docs sweeps, README/CHANGELOG freshness.',
  },
  'test-doctor': {
    what: 'Flaky-test triage: classifies failures as broken, flaky, or obsolete; proposes minimal fixes and never weakens assertions to go green.',
    use: 'Nightly CI hygiene on repos with noisy suites.',
  },
  'bug-hunter': {
    what: 'Evidence-first defect investigation — forms hypotheses, gathers proof from code and logs, pinpoints root cause before touching anything.',
    use: '“Why is this failing?” investigations you want done while you sleep.',
  },
  'code-reviewer': {
    what: 'Read-only review of recent changes across correctness, security, error handling, and clarity — severity-rated findings with file:line evidence.',
    use: 'Pre-PR review passes on every branch, before a human reviewer spends time.',
  },
  'refactor-engineer': {
    what: 'Small, behavior-preserving refactors with tests proving equivalence. Rejects opportunistic rewrites by contract.',
    use: 'Paying down tech debt one safe, reviewable step at a time.',
  },
  'perf-engineer': {
    what: 'Measures before optimizing: profiles hotspots, quantifies wins, and only lands changes with before/after numbers.',
    use: 'Scheduled performance patrols on latency-sensitive services.',
  },
  'security-auditor': {
    what: 'Adversarial read of the codebase: injection, secrets handling, authz gaps, unsafe deserialization, supply-chain risk. Findings-only — never edits.',
    use: 'Weekly security sweeps between real audits.',
  },
  'release-engineer': {
    what: 'Release preparation: changelog drafts from history, version bumps, build verification, release-notes assembly. Never publishes on its own.',
    use: 'Cutting predictable weekly releases without the ritual.',
  },
  'ci-investigator': {
    what: 'CI failure triage: reads logs, isolates the failing step, distinguishes infra flakes from real breakage, proposes the smallest fix.',
    use: 'Overnight red-build investigation so mornings start green.',
  },
  'repo-health-monitor': {
    what: 'Read-only health patrol: stale branches, aging TODOs, failing schedules, dependency drift, unowned areas — a prioritized watchlist each run.',
    use: 'A weekly pulse check for repos nobody has time to inspect.',
  },
  'changelog-writer': {
    what: 'Turns commit history into an honest, human-readable changelog: user-facing changes first, internal churn summarized, nothing invented.',
    use: 'Keeping CHANGELOG.md and release notes truthful automatically.',
  },
};

interface ProfileRowT {
  id: string;
  slug: string;
  name: string;
  color?: string | null;
  avatar?: string | null;
  engine?: string;
  model?: string | null;
  permission_mode?: string | null;
  budget_usd?: number | null;
  max_turns?: number | null;
  skills_json?: string;
  builtin?: number;
  category?: string | null;
  featured?: number;
}

const COLOR_SWATCHES = ['#E8A33D', '#7FD8C8', '#B9A7F2', '#5EA7F0', '#4BC97F', '#E05C5C', '#9BA1B6', '#F2D06B'];
const GLYPHS = ['◆', '✚', '✎', '⚡', '🛠', '🧪', '📊', '🤖'];

export default function AgentsView({ version }: { version: number }): JSX.Element {
  const profiles = useAsync(() => api.profiles(), [version]);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  const all = profiles.data ?? [];
  const categories = ['All', ...Array.from(new Set(all.map((p) => p.category).filter((c): c is string => !!c))).sort()];
  const q = query.trim().toLowerCase();
  const visible = all.filter((p) => {
    if (category !== 'All' && (p.category ?? 'Uncategorized') !== category) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      (p.category ?? '').toLowerCase().includes(q) ||
      (BUILTIN_EXPLAIN[p.slug]?.what ?? '').toLowerCase().includes(q)
    );
  });
  // Featured first, then built-ins, then custom — stable within each tier.
  const sorted = [...visible].sort((a, b) =>
    (b.featured ?? 0) - (a.featured ?? 0) || (b.builtin ?? 0) - (a.builtin ?? 0) || a.name.localeCompare(b.name));

  return (
    <div className="agents-page">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Agent Library</h2>
          <p className="text-xs text-muted">
            A profile is a named persona: its instructions load into every run booked with it, plus its own
            model, permission mode, and budget defaults.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> New profile
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents — name, skill, or what they do…"
          aria-label="Search agent library"
          className="max-w-sm"
        />
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            aria-pressed={category === c}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              category === c ? 'border-accent bg-surface-active text-fg' : 'border-border text-muted hover:bg-surface-hover'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {profiles.loading && <p className="state-line">Loading…</p>}
      {profiles.error && <div className="error-banner">{profiles.error}</div>}

      {sorted.length === 0 && !profiles.loading ? (
        <p className="state-line">
          No agents match {q ? `“${query}”` : 'this filter'}. Clear the search or create a new profile.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sorted.map((p) => (
            <ProfileCard key={p.id} p={p} />
          ))}
        </div>
      )}

      <CreateProfileDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          profiles.reload();
        }}
      />
    </div>
  );
}

function ProfileCard({ p }: { p: ProfileRowT }): JSX.Element {
  const explain = BUILTIN_EXPLAIN[p.slug];
  let skills: Array<{ name: string; version: string }> = [];
  try {
    skills = JSON.parse(p.skills_json ?? '[]');
  } catch {}
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-semibold"
            style={{ backgroundColor: `${p.color ?? '#9ba1b6'}22`, color: p.color ?? undefined }}
          >
            {p.avatar ?? '◆'}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <strong className="truncate text-compact">{p.name}</strong>
              {!!p.builtin && <Badge variant="info">built-in</Badge>}
              {p.category && <Badge variant="outline">{p.category}</Badge>}
            </div>
            <code className="text-xxs text-dim">@{p.slug}</code>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          {explain?.what ?? 'Custom profile you created — its instructions are applied to every run booked with it.'}
        </p>
        {explain && <p className="text-xs text-dim">Use for: {explain.use}</p>}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {skills.map((s) => (
            <Badge key={s.name} variant="outline" title={`skill v${s.version}`}>
              <Sparkles className="mr-1 inline h-3 w-3" />
              {s.name}
            </Badge>
          ))}
          <Badge variant="outline">${(p.budget_usd ?? 2).toFixed(2)}</Badge>
          <Badge variant="outline">{p.engine === 'codex' ? 'Codex' : p.engine === 'opencode' ? 'OpenCode' : 'Claude'}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateProfileDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [color, setColor] = useState(COLOR_SWATCHES[0]!);
  const [glyph, setGlyph] = useState(GLYPHS[0]!);
  const [promptExtra, setPromptExtra] = useState('');
  const [maxUsd, setMaxUsd] = useState('2');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // auto-slug from name until slug is touched manually
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (!slugTouched) setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32));
  }, [name, slugTouched]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fetch('/profiles', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${localStorage.getItem('clockwork.token')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          slug,
          name,
          color,
          glyph,
          engine: 'cli',
          permissionMode: 'acceptEdits',
          budget: { maxUsd: Number(maxUsd) || 2, maxTurns: 50, timeoutSec: 3600 },
          skills: [],
          mcpAllow: [],
          contextRoots: [],
          systemPromptExtra: promptExtra || undefined,
          delivery: { osNotify: true },
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}) as any)).error ?? `HTTP ${r.status}`);
      });
      onCreated();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogTitle>New agent profile</DialogTitle>
        <DialogDescription>
          Its instructions and defaults apply to every run booked with this profile.
        </DialogDescription>

        <div className="mt-3 space-y-3">
          <div>
            <Label htmlFor="ap-name">Name</Label>
            <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Test Doctor" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ap-slug">Handle (@slug)</Label>
              <Input id="ap-slug" className="mono" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} placeholder="test-doctor" />
            </div>
            <div>
              <Label htmlFor="ap-usd">Budget USD</Label>
              <Input id="ap-usd" className="mono" type="number" min={0.5} step={0.5} value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Glyph &amp; color</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {GLYPHS.map((g) => (
                <button
                  key={g}
                  onClick={() => setGlyph(g)}
                  aria-pressed={glyph === g}
                  className={`h-8 w-8 rounded-md border text-sm ${glyph === g ? 'border-accent bg-surface-active' : 'border-border text-muted hover:bg-surface-hover'}`}
                >
                  {g}
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-border" />
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`color ${c}`}
                  aria-pressed={color === c}
                  className={`h-7 w-7 rounded-full border-2 ${color === c ? 'border-fg' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <div>
            <Label htmlFor="ap-prompt">Instructions (system prompt)</Label>
            <Textarea
              id="ap-prompt"
              value={promptExtra}
              onChange={(e) => setPromptExtra(e.target.value)}
              placeholder={'Who this agent is, hard rules, output contract…\nExample: "You are a flaky-test detective…"'}
            />
          </div>
          {err && <div className="error-banner">{err}</div>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !name.trim() || !slug.trim()} onClick={() => void create()}>
            Create profile
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
