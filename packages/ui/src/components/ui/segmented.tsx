import * as React from 'react';
import { cn } from '../../lib/cn';

/** Controlled segmented control (view switchers, schedule type, theme). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = 'default',
  'aria-label': ariaLabel,
}: {
  options: Array<{ value: T; label: React.ReactNode; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: 'sm' | 'default';
  'aria-label'?: string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded-lg border border-border bg-bg p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md font-medium transition-colors',
            size === 'sm' ? 'px-2.5 h-6 text-xs' : 'px-3.5 h-7 text-xs',
            value === o.value
              ? 'bg-surface-active text-fg shadow-sm'
              : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
