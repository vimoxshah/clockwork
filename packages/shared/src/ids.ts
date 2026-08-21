import { ulid } from 'ulid';

/** ULIDs everywhere (stack #11): sortable, collision-safe, branch-name embeddable. */
export const newId = (): string => ulid();

/** Branch naming per arch §5 / FR-17: clockwork/<task-slug>/<run-id> — never main. */
export const branchFor = (taskSlug: string, runId: string): string =>
  `clockwork/${taskSlug}/${runId}`;

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
