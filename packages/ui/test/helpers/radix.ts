/**
 * Driving a Radix Select from jsdom.
 *
 * Radix positions its listbox with pointer capture and scrolls the active item
 * into view. jsdom implements neither, so opening a Select throws
 * `candidate?.scrollIntoView is not a function` and the listbox never mounts —
 * a test then reads zero options and, if its assertions are negative, passes
 * while measuring nothing. That is the exact failure mode test/helpers/dom.tsx
 * was written for, one layer down.
 *
 * These four no-ops are the whole fix. They are installed at import time, not
 * inside a hook, because the Select can open during the first commit.
 */
import { waitFor } from './dom';

type Stubbable = Element & {
  scrollIntoView?: () => void;
  hasPointerCapture?: (id: number) => boolean;
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
};
const proto = Element.prototype as Stubbable;
proto.scrollIntoView ??= function scrollIntoView(): void {};
proto.hasPointerCapture ??= function hasPointerCapture(): boolean {
  return false;
};
proto.setPointerCapture ??= function setPointerCapture(): void {};
proto.releasePointerCapture ??= function releasePointerCapture(): void {};

/**
 * Options live in a portal on `document.body`, never under the trigger, and the
 * portal mounts a tick after the click — reading synchronously returns an empty
 * list, which is the silent-pass shape again.
 */
export async function openOptions(trigger: Element | null): Promise<HTMLElement[]> {
  if (!trigger) throw new Error('select trigger missing from the DOM');
  (trigger as HTMLElement).click();
  await waitFor(
    () => document.body.querySelectorAll('[role="option"]').length > 0,
    'the select listbox to mount in the portal',
  );
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
}

/**
 * Pick the option whose text is exactly `label`.
 *
 * Exact, not `includes`: an hour list holds both "1 AM" and "11 AM", so a
 * substring match would silently pick the wrong one and the test would still
 * be green.
 */
export async function pickOption(trigger: Element | null, label: string): Promise<void> {
  const options = await openOptions(trigger);
  const hit = options.find((o) => o.textContent?.trim() === label);
  if (!hit) {
    throw new Error(`no option "${label}" — saw ${JSON.stringify(options.map((o) => o.textContent?.trim()))}`);
  }
  hit.click();
}

/** Set a TimeField built with `testIdPrefix`, by its visible labels. */
export async function pickTime(root: ParentNode, prefix: string, hour: string, minute?: string): Promise<void> {
  await pickOption(root.querySelector(`[data-testid="${prefix}-hour"]`), hour);
  if (minute !== undefined) await pickOption(root.querySelector(`[data-testid="${prefix}-minute"]`), minute);
}
