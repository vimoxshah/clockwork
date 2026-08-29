/**
 * ModelSelector (commercial gauntlet §17/18): searchable, keyboard-first model
 * chooser. Friendly names lead; raw IDs live under Advanced. Capability chips
 * are derived honestly from registry data (context size, pricing, modalities).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { cn } from '../lib/cn';

export interface SelectorModel {
  id: string;
  name?: string;
  context?: number;
  inPerM?: number;
  outPerM?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

function chips(m: SelectorModel): string[] {
  const out: string[] = [];
  if ((m.context ?? 0) >= 500_000) out.push('Long context');
  if (m.reasoning) out.push('Reasoning');
  if (m.vision) out.push('Vision');
  if (m.tools) out.push('Tools');
  if ((m.inPerM ?? 99) <= 0.5 && (m.outPerM ?? 99) <= 2.5) out.push('Economical');
  return out.slice(0, 3);
}

function priceLine(m: SelectorModel): string {
  if (m.inPerM == null && m.outPerM == null) return m.id;
  const parts: string[] = [];
  if (m.context) parts.push(`${Math.round(m.context / 1000)}k ctx`);
  // S-review (Hermes): guard against malformed registry numbers.
  const fin = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  if (fin(m.inPerM) && fin(m.outPerM)) parts.push(`$${m.inPerM}/M in · $${m.outPerM}/M out`);
  return parts.join(' · ');
}

export function ModelSelector({
  models,
  value,
  onChange,
  placeholder = 'Choose a model…',
  allowCustom = true,
  customPlaceholder = 'model-id',
}: {
  models: SelectorModel[];
  value: string;
  onChange: (id: string, label: string | undefined) => void;
  placeholder?: string;
  allowCustom?: boolean;
  customPlaceholder?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customId, setCustomId] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = models.find((m) => m.id === value);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(term) || (m.name ?? '').toLowerCase().includes(term),
    );
  }, [models, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => searchRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (m: SelectorModel): void => {
    onChange(m.id, m.name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (customMode) return; // custom input handles its own keys
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) pick(filtered[active]); }
  };

  const submitCustom = (): void => {
    const id = customId.trim();
    if (!id) return;
    onChange(id, undefined);
    setCustomId('');
    setCustomMode(false);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-lg border border-strong bg-bg px-3 py-2 text-compact text-fg',
          'focus:outline-none focus:ring-2 focus:ring-accent',
        )}
        aria-label="Model selector"
        data-testid="model-selector-trigger"
      >
        <span className="truncate">
          {selected ? (
            <>
              <strong>{selected.name ?? selected.id}</strong>
              {selected.name && <span className="ml-2 text-xxs text-dim">{selected.id}</span>}
            </>
          ) : value ? (
            value
          ) : (
            <span className="text-dim">{placeholder}</span>
          )}
        </span>
        <ChevronsUpDown className="h-4 w-4 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 text-dim" aria-hidden />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search models…"
            aria-label="Search models"
            className="w-full bg-transparent text-compact outline-none placeholder:text-dim"
          />
        </div>

        {!customMode && (
          <div ref={listRef} role="listbox" aria-label="Models" className="max-h-72 overflow-auto p-1">
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-dim">No model matches “{q}”.</p>
            )}
            {filtered.map((m, i) => (
              <button
                key={m.id}
                data-idx={i}
                role="option"
                aria-selected={m.id === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(m)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-compact',
                  i === active ? 'bg-surface-hover' : '',
                  m.id === value ? 'ring-1 ring-accent' : '',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.name ?? m.id}</span>
                  <span className="block truncate text-xxs text-dim">{priceLine(m)}</span>
                  {chips(m).length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {chips(m).map((c) => (
                        <span key={c} className="rounded border border-border px-1.5 py-0.5 text-micro text-muted">{c}</span>
                      ))}
                    </span>
                  )}
                </span>
                {m.id === value && <Check className="mt-1 h-4 w-4 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        )}

        {customMode ? (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <input
              autoFocus
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } }}
              placeholder={customPlaceholder}
              aria-label="Custom model ID"
              className="h-8 w-full rounded-md border border-strong bg-bg px-2 font-mono text-caption outline-none focus:ring-2 focus:ring-accent"
            />
            <button className="btn small primary" onClick={submitCustom}>Use</button>
          </div>
        ) : (
          allowCustom && (
            <button
              onClick={() => setCustomMode(true)}
              className="w-full border-t border-border px-3 py-2 text-left text-caption text-dim hover:bg-surface-hover hover:text-fg"
            >
              Use a custom model ID… <span className="text-xxs">(advanced)</span>
            </button>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}
