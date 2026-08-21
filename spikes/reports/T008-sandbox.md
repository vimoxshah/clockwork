# T-008 — Sandbox PoC report

- Date: 2026-08-21T17:57:18.704Z
- Profile generator version: see packages/runner/src/sandbox.ts SANDBOX_PROFILE_VERSION

| Attempt | Expected | Got | Verdict |
|---|---|---|---|
| read ~/.ssh/id_ed25519 (credential) | DENIED | exit=1 stderr=cat: /Users/vimoxshah/.ssh/id_ed25519: Operation not permitted  | PASS |
| list ~/.aws | DENIED | exit=1 stderr=ls: /Users/vimoxshah/.aws: Operation not permitted  | PASS |
| read login.keychain-db | READABLE (documented exception: engine auth via keychain ACL; see sandbox.ts header) | exit=0 stderr= | PASS |
| write outside worktree (scratch root file) | DENIED | exit=1 stderr=touch: /var/folders/r1/nfjt6c9x72jf4wd6mmw0fzb00000gn/T/cw-t008-UjE9H0/escape.txt: Operation not permitted  | PASS |
| write to home dir | DENIED | exit=1 stderr=touch: /Users/vimoxshah/cw-escape-test: Operation not permitted  | PASS |
| write into ro context root (other repo) | DENIED | exit=1 stderr=touch: /var/folders/r1/nfjt6c9x72jf4wd6mmw0fzb00000gn/T/cw-t008-UjE9H0/other-repo/nope.txt: Operation not permitted  | PASS |
| write via symlink escaping worktree | DENIED | exit=1 stderr=touch: /var/folders/r1/nfjt6c9x72jf4wd6mmw0fzb00000gn/T/cw-t008-UjE9H0/worktree/evil-link/escaped.txt: Operation not permitted  | PASS |
| read shell history | DENIED | exit=1 stderr=cat: /Users/vimoxshah/.zsh_history: Operation not permitted  | PASS |
| read ~/.gnupg | DENIED | exit=1 stderr=ls: /Users/vimoxshah/.gnupg: Operation not permitted  | PASS |
| git works in-sandbox (status) | OK | exit=0 stderr= | PASS |
| git commit in-sandbox | OK | exit=0 stderr= | PASS |
| node works in-sandbox | OK | exit=0 stderr= | PASS |
| claude -p completes inside sandbox (12s) | OK + SANDBOX_OK in stream | exit=0 stdoutHasOk=true stderr= | PASS |
