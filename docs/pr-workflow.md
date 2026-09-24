# One-click PRs from reports

A run that committed to its branch can become a pull request without leaving
Clockwork: open the run's report in the **Inbox**, click **Open PR**, copy the
link. The daemon pushes the branch and creates the PR through the GitHub API
with a PAT you paste once — no `gh` CLI involved anywhere.

## Setup (once)

1. Mint a fine-grained PAT at github.com/settings/tokens with **contents:
   read + write** on the repos you book work against.
2. **Settings → GitHub** → paste → Save → Validate (GitHub answers with your
   login when the value is good).
3. The value lives in `delivery-creds.json` at file mode 0600 beside the
   other credentials (or `CLOCKWORK_DELIVER_GITHUB_PAT` in the environment).
   It is write-only through the API, never rendered back, never handed to a
   running agent, and never written into any git config — pushes authenticate
   through a transient git header that dies with the command.

## What happens on click

1. **Confirm.** The button first asks inline — push this run's branch to
   origin and open the PR? — because pushing publishes commits. Review the
   diff above, then confirm. Nothing pushes on the first click.
2. The daemon verifies locally: repo usable, branch still exists (worktree or
   main repo — retention may have pruned the worktree), base resolves, and the
   branch holds commits beyond the base. An empty branch **refuses** with the
   reason instead of opening an empty PR.
2. The origin remote must be an `https://github.com/…` URL. SSH remotes
   refuse with the fix (`git remote set-url origin https://…` or push
   manually) — the daemon has no ssh-agent and never reads keys.
3. The branch is pushed (`--set-upstream`, so a retry just works).
4. Open PRs off that branch are looked up first: an existing one is
   **returned, never duplicated**.
5. Otherwise the PR is created with the run summary, diffstat, cost/turns,
   and a footer naming Clockwork as the author of the push, not the code.

Every refusal names its fix in the button's error line. Nothing here edits
your code: the pushed commits are exactly the agent's, byte for byte.

## Limits, stated plainly

- github.com only. Other hosts refuse with `not_github`.
- One branch, one base, non-draft PRs. Review before merging — the agent's
  tests passing is evidence, not proof.
- A run whose branch was pruned (retention) or whose repo is gone cannot
  produce a PR; the button says which.
