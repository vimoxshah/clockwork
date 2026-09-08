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
import { useState } from 'react';
import { DayPicker } from 'react-day-picker';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { TimeField } from './time-field';
import { Button } from './button';
import { cn } from '../../lib/cn';

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
  const minutes = value.getHours() * 60 + value.getMinutes();

  const setMinutes = (m: number): void => {
    const d = new Date(value);
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
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
          <TimeField
            value={minutes}
            onChange={setMinutes}
            minuteStep={MINUTE_STEP}
            testIdPrefix="dtp"
          />
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => {
              const d = new Date();
              setMinutes(d.getHours() * 60 + (Math.round(d.getMinutes() / MINUTE_STEP) * MINUTE_STEP) % 60);
            }}
          >
            Now
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
