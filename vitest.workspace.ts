import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/runner',
  'packages/daemon',
  'packages/ui',
]);
