/**
 * Intent-first agent picker (Phase: profile-selection UX rework).
 * Compact: search field + recommended intents + recents + "browse all"
 * expander. Never a giant scrolling list.
 */
import { useMemo, useState } from 'react';

export interface PickerProfile {
  id: string;
  name: string;
  slug: string | null;
  avatar: string | null;
  color: string | null;
}

/** Intent keywords → matched profile slug prefixes. Order = recommendation priority. */
const INTENTS: Array<{ label: string; glyph: string; match: RegExp }> = [
  { label: 'Update dependencies', glyph: '📦', match: /dep/i },
  { label: 'Fix bugs', glyph: '🐛', match: /bug|hunt/i },
  { label: 'Improve tests', glyph: '🧪', match: /test/i },
  { label: 'Audit security', glyph: '🔐', match: /secur/i },
  { label: 'Improve performance', glyph: '⚡', match: /perf/i },
  { label: 'Review code', glyph: '⌕', match: /review/i },
  { label: 'Refactor code', glyph: '⟐', match: /refactor/i },
  { label: 'Check docs drift', glyph: '✎', match: /docs|changelog/i },
  { label: 'Investigate CI failures', glyph: '⚙', match: /ci/i },
];

export function AgentPicker({
  profiles,
  value,
  onChange,
}: {
  profiles: PickerProfile[];
  value: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);

  const term = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!term) return [];
    return profiles.filter((p) => p.name.toLowerCase().includes(term) || (p.slug ?? '').includes(term));
  }, [profiles, term]);

  const recommended = useMemo(() => {
    const out: Array<{ profile: PickerProfile; intent: string; glyph: string }> = [];
    for (const p of profiles) {
      if (p.id === value && !term) continue;
      for (const it of INTENTS) {
        if (it.match.test(p.name) || (p.slug && it.match.test(p.slug))) {
          out.push({ profile: p, intent: it.label, glyph: it.glyph });
          break;
        }
      }
    }
    return out.slice(0, 4);
  }, [profiles, value, term]);

  const visible = showAll || term ? filtered.length > 0 || term ? null : null : null;
  void visible;

  const listAll = profiles.filter((p) => p.id !== value);

  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search agents or describe the job…"
        aria-label="Search agent profiles"
        data-testid="agent-search"
        className="w-full"
      />

      {/* exact search results */}
      {term && (
        <div className="space-y-1" role="listbox" aria-label="Search results">
          {filtered.length === 0 && <p className="hint">No agent matches “{q}”. Generalist handles anything.</p>}
          {filtered.slice(0, 6).map((p) => (
            <button
              key={p.id}
              onClick={() => { onChange(p.id); setQ(''); }}
              className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-[13px] hover:bg-surface-hover"
            >
              <span aria-hidden>{p.avatar ?? '◆'}</span>
              <strong>{p.name}</strong>
              {p.slug && <span className="mono text-dim">@{p.slug}</span>}
            </button>
          ))}
        </div>
      )}

      {!term && (
        <>
          {/* currently selected */}
          {value && (() => {
            const sel = profiles.find((p) => p.id === value);
            if (!sel) return null;
            return (
              <div className="flex items-center gap-2 rounded-lg border border-strong bg-surface-active px-3 py-2 text-[13px]" data-testid="selected-agent">
                <span aria-hidden>{sel.avatar ?? '◆'}</span>
                <strong>{sel.name}</strong>
                <span className="chip completed" style={{ marginLeft: 'auto' }}>selected</span>
                <button onClick={() => onChange('')} className="text-dim hover:text-fg" aria-label="Clear selection">✕</button>
              </div>
            );
          })()}

          {/* recommended by intent */}
          {recommended.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-dim">Recommended</p>
              <div className="grid grid-cols-2 gap-2">
                {recommended.map(({ profile: p, intent, glyph }) => (
                  <button
                    key={p.id}
                    onClick={() => onChange(p.id)}
                    title={intent}
                    className="rounded-lg border border-border px-3 py-2 text-left text-[13px] hover:border-strong hover:bg-surface-hover"
                  >
                    <span aria-hidden className="mr-1.5">{glyph}</span>
                    {p.name}
                    <div className="text-[11px] text-dim">{intent}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* browse all */}
          <button
            onClick={() => setShowAll((s) => !s)}
            className="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline"
            aria-expanded={showAll}
          >
            {showAll ? '↑ Hide all agents' : `Browse all ${profiles.length} agents →`}
          </button>
          {showAll && (
            <div className="max-h-52 space-y-1 overflow-auto rounded-lg border border-border p-2" role="radiogroup" aria-label="All agents">
              {listAll.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={value === p.id}
                  onClick={() => onChange(p.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-hover ${value === p.id ? 'bg-surface-active' : ''}`}
                >
                  <span aria-hidden>{p.avatar ?? '◆'}</span>
                  {p.name}
                  {p.slug && <span className="mono ml-auto text-[11px] text-dim">@{p.slug}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
