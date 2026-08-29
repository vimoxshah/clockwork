/**
 * DateTimePicker — Popover + DayPicker month grid + time fields.
 * Replaces the native datetime-local (which rendered unstyled popups and
 * broke dark mode). Fully themed via Tailwind tokens.
 */
import { useState } from 'react';
import { DayPicker } from 'react-day-picker';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Button } from './button';
import { cn } from '../../lib/cn';

const p2 = (n: number): string => String(n).padStart(2, '0');

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
  const hh = p2(value.getHours());
  const mm = p2(value.getMinutes());

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
            cell: 'p-0.5 text-center text-ui',
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
        <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
          <span className="text-xs text-dim">Time</span>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Hour"
              className="h-8 rounded-md border border-strong bg-bg px-2 text-ui text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              value={hh}
              onChange={(e) => setTime(Number(e.target.value), value.getMinutes())}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{p2(i)}</option>
              ))}
            </select>
            <span className="text-dim">:</span>
            <select
              aria-label="Minute"
              className="h-8 rounded-md border border-strong bg-bg px-2 text-ui text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              value={mm}
              onChange={(e) => setTime(value.getHours(), Number(e.target.value))}
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                <option key={m} value={m}>{p2(m)}</option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            onClick={() => {
              const d = new Date();
              setTime(d.getHours(), Math.round(d.getMinutes() / 5) * 5 % 60);
            }}
          >
            Now
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
