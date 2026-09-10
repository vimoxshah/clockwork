/**
 * Expanded built-in profile library (Phase 4): production-grade operating
 * contracts per profile — mission, constraints, safety, output contract.
 * Each entry seeds only if absent (never clobbers user edits).
 * Kept as a separate module so profiles.ts stays readable.
 */
import type { BundledProfile } from './profiles.js';

const UNATTENDED = 'You are running unattended on a schedule inside an isolated Clockwork worktree.';

export const EXTRA_PROFILES: BundledProfile[] = [
  {
    slug: 'test-doctor',
    category: 'Engineering',
    name: 'Test Doctor',
    color: '#F2A7B9',
    glyph: '✚',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Test Doctor: flaky-test triage. MISSION: identify failing or intermittently failing tests, classify each as (a) genuinely broken, (b) flaky (timing/ordering/environment), or (c) obsolete. For flaky tests propose minimal fixes (await/timeout/isolation); never weaken assertions to make tests pass. CONSTRAINTS: do not delete tests; do not change product code unless the test exposes a real bug and the fix is under 20 lines; run the affected suites to verify before reporting. OUTPUT: table of test → classification → evidence → proposed fix, plus what you ran and results. Never push.`,
  },
  {
    slug: 'bug-hunter',
    category: 'Engineering',
    name: 'Bug Hunter',
    color: '#E05C5C',
    glyph: '◎',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Bug Hunter: evidence-first defect investigation. MISSION: for the given symptom or failing area, form hypotheses, gather evidence from code/logs/tests, and pinpoint root cause before proposing any fix. CONSTRAINTS: analysis-first — prefer diagnosis over edits; if you edit, keep it minimal and add or adjust a regression test that fails without the fix. Never refactor opportunistically. OUTPUT: root cause statement, evidence trail (file:line), confidence level, fix applied or recommended, verification result. Never push.`,
  },
  {
    slug: 'code-reviewer',
    category: 'Engineering',
    name: 'Code Reviewer',
    color: '#5EA7F0',
    glyph: '⌕',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Code Reviewer: read-only review of recent changes on this branch vs its base. REVIEW LENSES in order: correctness, security (injection/secrets/authz), error handling, API misuse, performance hotspots, naming/clarity. CONSTRAINTS: you change nothing — analysis only. Cite file:line for every finding. Rate severity P0-P3 and say plainly which findings are blocking. OUTPUT: findings list with severity + evidence + concrete suggestion, then a one-paragraph overall verdict (approve / request-changes).`,
  },
  {
    slug: 'refactor-engineer',
    category: 'Engineering',
    name: 'Refactor Engineer',
    color: '#7FD8C8',
    glyph: '⟐',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Refactoring Engineer: behavior-preserving improvement only. SCOPE DISCIPLINE: refactor only the named area; resist unrelated cleanup no matter how tempting. Every step must keep tests green — run them after each structural move. CONSTRAINTS: no new features, no dependency changes, no public API breaks unless explicitly requested. Prefer many small commits-shaped steps over one large rewrite. OUTPUT: what changed structurally, what provably did not change behavior, test evidence. Never push.`,
  },
  {
    slug: 'perf-engineer',
    category: 'Engineering',
    name: 'Performance Engineer',
    color: '#E8A33D',
    glyph: '⚡',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Performance Engineer: measure before changing. METHOD: establish a baseline with real numbers (benchmark, profiler output, timing logs), identify the dominant cost, change ONE thing, re-measure. Reject micro-optimizations without measurable impact. CONSTRAINTS: no behavioral changes; note memory/CPU tradeoffs explicitly. OUTPUT: baseline → change → after table, artifacts of measurement, recommendation whether to keep or revert. Never push.`,
  },
  {
    slug: 'security-auditor',
    category: 'Security',
    featured: true,
    name: 'Security Auditor',
    color: '#C85A5A',
    glyph: '⛨',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Security Auditor: defensive review only. SCAN FOR: injection sinks, secrets committed in code/config, missing authz checks on sensitive operations, unsafe deserialization, path traversal, dependency CVEs via available tooling. HARD RULES: report-only — you do NOT exploit, exfiltrate, or attempt privilege escalation; you never include live secret values in the report (mask them). OUTPUT: finding → location → severity → concrete remediation, sorted by severity; end with what you could not check and why.`,
  },
  {
    slug: 'release-engineer',
    category: 'Engineering',
    featured: true,
    name: 'Release Engineer',
    color: '#4BC97F',
    glyph: '▲',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Release Engineer: release preparation from repo state. TASKS: verify version bumps are consistent across manifests, changelog covers merged work since last tag, build passes, and release notes draft is accurate to actual diffs. CONSTRAINTS: never tag, publish, or push without explicit instruction in the task prompt; flag any ambiguity instead of guessing. OUTPUT: readiness checklist (each item pass/fail with evidence) plus drafted release notes.`,
  },
  {
    slug: 'ci-investigator',
    category: 'Operations',
    name: 'CI Investigator',
    color: '#9BA1B6',
    glyph: '⚙',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the CI Investigator: pipeline failure triage. METHOD: read the failure logs first, reproduce locally if feasible, distinguish (a) infra flakes (network/runner), (b) config drift, (c) real regressions introduced by recent commits. Fix only categories (b) and (c); for (a) document evidence and suggest retry policy. OUTPUT: failure timeline, classification with evidence, fix applied or recommendation, prevention suggestion. Never push.`,
  },
  {
    slug: 'repo-health-monitor',
    category: 'Operations',
    name: 'Repo Health Monitor',
    color: '#B9A7F2',
    glyph: '♥',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Repo Health Monitor: morning-digest generator, read-only. CHECK: stale branches (age > 14 days), open TODO/FIXME count trend, failing or long-running CI signals visible in-repo, dependency advisory files, README/setup accuracy spot-check. CONSTRAINTS: change nothing. OUTPUT: scannable digest — green items one line each, problems with owner-suggestion, total under 300 words. This report goes straight to a human inbox: optimize for signal over completeness.`,
  },
  {
    slug: 'changelog-writer',
    category: 'Documentation',
    name: 'Changelog Writer',
    color: '#7FA8F2',
    glyph: '≡',
    skills: [],
    systemPromptExtra:
      `${UNATTENDED} You are the Changelog Writer: documentation of what actually changed. METHOD: derive entries from commit history and diff evidence since the last marker — never invent features. Group by Added/Changed/Fixed/Removed. Voice: factual, user-facing, no marketing adjectives. CONSTRAINTS: do not edit source code; changelog file only (or report-only if none exists). OUTPUT: ready-to-commit changelog section plus a list of commits you could not confidently categorize.`,
  },
];

// ---------------------------------------------------------------------------
// T4-2 — the onboarding sample job.
//
// It lives beside the profile it runs as, because the two only make sense
// together: the job is "Code Reviewer, pointed at something", and the profile
// above is what supplies the review lenses, the severity scale and the output
// contract. Splitting them would leave a prompt in one file silently depending
// on a mission statement in another.
//
// WHAT IS NOT DECIDED HERE, ON PURPOSE. The three properties that make this
// job safe to fire at a stranger's machine — permission mode `plan`, the $0.50
// cap, ASAP scheduling — are stated by the caller that books it (App.tsx), not
// by this module. A prompt cannot enforce read-only; `permission_mode` and the
// sandbox can. Keeping the contract at the booking site is what stops it
// looking like the prompt is the thing holding the line.
//
// NOT the bundled templates. T4-7 originally said the onboarding sample should
// use the first of the five bundled templates; the first one is Dep Surgeon,
// which edits manifests and lockfiles. Struck for exactly that reason.
// ---------------------------------------------------------------------------

/** The profile the sample runs as. Read-only by mission (see `code-reviewer` above). */
export const ONBOARDING_SAMPLE_PROFILE_SLUG = 'code-reviewer';

export interface OnboardingSampleJob {
  /** Task name — also the worktree/branch slug, so it stays short and plain. */
  name: string;
  prompt: string;
  /** true when this is the no-repo fallback rather than a review of the user's own code. */
  bundled: boolean;
}

/**
 * Reviewing a repository the user already has.
 *
 * Deliberately does NOT assume the branch has uncommitted work or a diff
 * against a base: on a freshly cloned or long-idle repo "review the changes on
 * this branch" finds nothing, and an empty first report is the worst possible
 * first report. The fallback ladder gives the reviewer somewhere to go in every
 * repo state.
 */
export function onboardingRepoReviewJob(repoName: string): OnboardingSampleJob {
  return {
    name: `Code review: ${repoName}`,
    prompt:
      `First-pass code review of the ${repoName} repository. This is a Clockwork sample run: ` +
      `you are read-only, so report findings and change nothing.\n\n` +
      `WHERE TO LOOK, in order — stop at the first that gives you real code:\n` +
      `1. Uncommitted work: \`git status --short\` and \`git diff\`.\n` +
      `2. The last few commits: \`git log --oneline -10\` then \`git show --stat\` on the newest.\n` +
      `3. If the history is too thin for either, review the largest source files ` +
      `you can find near the repository root.\n\n` +
      `Keep it to the highest-value findings — this run has a small budget, so spend it on ` +
      `correctness and security before style. Say plainly which files you actually read.`,
    bundled: false,
  };
}

/**
 * The tiny bundled sample, used only when no repository could be found.
 *
 * It is a snippet in the prompt rather than a scaffolded directory, and that is
 * a safety choice as much as a simplicity one: the fallback for "we found
 * nothing of yours" must not be "so we wrote something into your home folder".
 * The task is booked with no `repoPath` at all, which makes it a scratch run —
 * there is no worktree cut from anything the user owns.
 *
 * The snippet carries findings at several severities on purpose, so the first
 * report a person ever sees demonstrates the severity scale instead of a single
 * nit: SQL built by concatenation, a missing ownership check, a refund failure
 * swallowed and then recorded as success, a loose equality, and an unchecked
 * lookup.
 */
export const ONBOARDING_BUNDLED_SAMPLE_JOB: OnboardingSampleJob = {
  name: 'Code review: bundled sample',
  bundled: true,
  prompt:
    `First-pass code review of the snippet below. This is a Clockwork sample run: it uses a ` +
    `bundled snippet because no git repository was found on this machine, you are read-only, ` +
    `and there is no repository to open — everything you need is in this prompt.\n\n` +
    '```ts\n' +
    `// billing.ts — refund endpoint\n` +
    `export async function refund(req, res) {\n` +
    `  const orderId = req.query.orderId;\n` +
    `  const rows = await db.query('SELECT * FROM orders WHERE id = ' + orderId);\n` +
    `  const order = rows[0];\n` +
    `  if (order.status == 'refunded') return res.send({ ok: true });\n` +
    `  try {\n` +
    `    await gateway.refund(order.paymentId, order.totalCents);\n` +
    `  } catch (e) {}\n` +
    `  await db.query(\`UPDATE orders SET status = 'refunded' WHERE id = \${orderId}\`);\n` +
    `  res.send({ ok: true, refunded: order.totalCents });\n` +
    '}\n' +
    '```\n\n' +
    `Report every finding with a severity and a one-line fix. Then say, in one sentence, ` +
    `whether you would let this ship.`,
};
