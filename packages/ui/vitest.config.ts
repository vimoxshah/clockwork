import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
    // Vitest's 5s default is spent before a test's own work begins: these files
    // `await import()` large component graphs, and on a loaded runner the
    // transform + jsdom setup alone can exceed it. Two file headers already
    // record that failure mode (version-skew.test.tsx:22-25,
    // screen-honesty.test.tsx:25-27), and a run under 2x CPU oversubscription
    // reproduced it — five tests died on `Test timed out in 5000ms` while
    // vitest reported `environment 1404s, collect 268s`.
    //
    // This raises the ceiling on IMPORT COST; it loosens no assertion. Every
    // wait in test/helpers/dom.tsx still fails at 10s with its own message, so
    // a genuinely broken component is still reported as a broken component
    // rather than as a timeout. The only thing this ceiling ever catches is a
    // module graph that would not finish loading.
    //
    // 60s, not 30s: with 14 busy loops on a 10-core box the two first-in-file
    // tests that pull the biggest graphs measured 26,989ms (tasks-workforce ›
    // "offers a switch for every section") and 26,699ms (workforce-settings ›
    // "gives every settings surface an anchor"). Both passed, but 3s of
    // headroom on a number driven by machine contention is not headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
