/**
 * DateTimePicker — Popover + DayPicker month grid + themed time fields.
 *
 * Replaces the native datetime-local (which rendered unstyled popups and broke
 * dark mode). The time controls were native <select> until they were reported
 * as "still not a proper date time picker component" — and in WKWebView, which
 * is the engine the desktop window actually uses, a native <select> is a macOS
 * popup menu drawn by the OS. It ignores the theme, ignores dark mode, and is
 * the one part of this component that was never ours. Chromium hides that,
 * which is why it survived: the earlier check was run in the wrong browser.
 */
import { useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Button } from './button';
import { cn } from '../../lib/cn';

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Minute granularity. Every schedule surface in the app is on a 5-minute grid. */
const MINUTE_STEP = 5;

function fmt(d: Date | undefined): string {
  if (!d) return 'Pick a date & time';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Label an hour the way the trigger above it does.
 *
 * The trigger renders through `toLocaleString`, so in en-US it says "02:00 PM"
 * while the hour control said "14" — the same instant, spelled two ways, one
 * inch apart. Deriving the label from the same locale machinery keeps them in
 * step and costs nothing: a 24-hour locale gets "14" in both places.
 */
function hourLabels(): string[] {
  const base = new Date(2000, 0, 1);
  return Array.from({ length: 24 }, (_, h) => {
    base.setHours(h, 0, 0, 0);
    return base.toLocaleTimeString(undefined, { hour: 'numeric' });
  });
}

export function DateTimePicker({
  value,
  onChange,
  id,
  className,
}: {
  value: Date;
  onChange: (d: Date) => void;
  id?: string;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const hours = useMemo(hourLabels, []);
  const hh = String(value.getHours());
  // A value off the grid (a prefill, a rule) must still show: snap for display
  // only, never write it back, or opening the picker would silently move the
  // time the user already chose.
  const mm = String(Math.round(value.getMinutes() / MINUTE_STEP) * MINUTE_STEP % 60);

  const setTime = (h: number, m: number): void => {
    const d = new Date(value);
    d.setHours(h, m, 0, 0);
    onChange(d);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          className={cn('w-full justify-start text-left font-normal h-9 bg-bg', !value && 'text-dim', className)}
        >
          <CalendarDays className="mr-1 opacity-60" />
          {fmt(value)}
        </Button>
      </PopoverTrigger>
      {/* No onInteractOutside guard, and that is checked rather than assumed.
          A Select renders its list in a portal outside this popover, so the
          obvious worry is that choosing an hour reads as a click outside and
          closes the whole picker. It does not: Radix keeps a stack of
          dismissable layers and the Select is a layer above this one. The
          guard written for it matched `[data-radix-select-content]`, an
          attribute Radix never emits — the listbox carries only data-side,
          data-align and data-state — so it was dead code claiming to hold
          something up. Verified in WebKit with it gone: picking 9 AM changes
          the value to 09:00 AM and the popover is still open. */}
      <PopoverContent className="w-auto p-0" align="start">
        <DayPicker
          mode="single"
          selected={value}
          defaultMonth={value}
          showOutsideDays
          onSelect={(d) => {
            if (!d) return;
            const next = new Date(value);
            onChange(new Date(d.getFullYear(), d.getMonth(), d.getDate(), next.getHours(), next.getMinutes()));
          }}
          classNames={{
            months: 'flex flex-col px-3 pt-3',
            month: 'space-y-2',
            caption: 'flex justify-center items-center gap-2 relative h-8',
            caption_label: 'text-sm font-semibold',
            nav: 'flex items-center gap-1 absolute inset-x-1 justify-between',
            nav_button: 'h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-surface-hover text-muted',
            nav_button_previous: 'left-0',
            nav_button_next: 'right-0',
            table: 'border-collapse',
            head_row: 'flex mb-1',
            head_cell: 'w-9 text-xxs uppercase tracking-wide text-dim font-medium',
            row: 'flex w-full',
            cell: 'p-0.5 text-center text-compact',
            day: cn(
              'h-8 w-9 rounded-md inline-flex items-center justify-center cursor-pointer',
              'hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-accent',
            ),
            day_selected: 'bg-accent text-[var(--accent-fg)] font-semibold hover:bg-accent hover:text-[var(--accent-fg)]',
            day_today: 'ring-1 ring-accent ring-inset font-semibold',
            day_outside: 'opacity-40',
            day_disabled: 'opacity-30 pointer-events-none',
          }}
          components={{
            IconLeft: () => <ChevronLeft className="h-4 w-4" />,
            IconRight: () => <ChevronRight className="h-4 w-4" />,
          }}
        />
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
          <span className="text-xs text-dim">Time</span>
          <Select value={hh} onValueChange={(v) => setTime(Number(v), Number(mm))}>
            <SelectTrigger aria-label="Hour" className="h-8 w-[5.5rem]" data-testid="dtp-hour">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hours.map((label, h) => (
                <SelectItem key={h} value={String(h)}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-dim">:</span>
          <Select value={mm} onValueChange={(v) => setTime(Number(hh), Number(v))}>
            <SelectTrigger aria-label="Minute" className="h-8 w-[4.25rem]" data-testid="dtp-minute">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP).map((m) => (
                <SelectItem key={m} value={String(m)}>{p2(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => {
              const d = new Date();
              setTime(d.getHours(), (Math.round(d.getMinutes() / MINUTE_STEP) * MINUTE_STEP) % 60);
            }}
          >
            Now
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
