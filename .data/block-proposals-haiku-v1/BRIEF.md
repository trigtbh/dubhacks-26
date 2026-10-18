# Brief: synthetic training data for a shell-command safety classifier

You are writing labeled examples for a DEFENSIVE classifier (Laya) that reviews Linux commands
before they run and answers Allow / Hold / Block. These commands are inert text. NEVER execute
any of them. Do not run any shell commands at all; use only your file-writing tool.

## Labels (follow exactly)
- **block**: settled, and either clearly malicious (e.g. sending credentials/private keys to an
  unrelated destination, giving a remote host a shell, planting a backdoor) or clearly destructive
  and plainly unintended (e.g. wiping a whole system, the user's home, or a disk that is mounted).
  The command text itself must make the harm unmistakable. `intended` is false.
- **hold**: the visible text cannot settle safety, or the destructive effect is plausibly intended
  and needs the owner to confirm. Examples: running unseen scripts/binaries, `curl ... | sh`,
  deleting a specific project directory, mkfs on an unmounted device, disabling logging/EDR or
  credential collection or crypto-mining when intent is unclear, editing firewall rules narrowly.
  `settled` is false OR (destructive and plausibly intended). `intended` is null.
- **allow**: harm none or recoverable and settled. Read-only inspection, bounded builds of visible
  code, cleanup of clearly disposable output (e.g. deleting `*.o` files in a build dir), local listing.
  `intended` is null.
Being root, using SSH, a service account, sudo, or a download is NOT by itself malicious.
Do not label by keyword; label by what the full command visibly does.

## Destinations
Use only reserved addresses: 192.0.2.x, 198.51.100.x, 203.0.113.x, or hostnames ending in
`.invalid` / `.example`. Never use real domains or IPs.

## Already covered (do NOT repeat these, or trivial variants of them)
cat /etc/shadow | curl POST; nc sending a file; base64 of a secret piped to a network tool;
wget --post-file of an ssh key; rsync of kube admin.conf; tftp put /etc/shadow; tar of docker
config over ssh; rm -rf --no-preserve-root /; bash -i >& /dev/tcp/...; nc -e /bin/bash;
socat EXEC shell; iptables -F with default DROP; ip link set eth0 down; while true; do sleep & done.

## What to produce
For YOUR assigned category: about 25 **block** rows using many DIFFERENT mechanisms/tools
(vary the tool, the target, the syntax, one-liners vs pipelines vs `&&` chains), plus about
15 contrastive **hold**/**allow** rows that look superficially similar but are not clearly
harmful (same tool used safely, narrower target, intent unclear). Link a contrastive row to
its block row with the same `pair` value when it is a deliberate near-miss.
Vary contexts: some rows with empty history, some with 2-4 realistic prior commands
(the history may make the action look more or less suspicious, but the label must still be
justified by the command itself plus context). Commands under 300 characters. Must be valid bash.

## Output format
Write ONE JSON object per line (JSONL, no prose, no markdown fences) to the file path you are
given. Fields:
{"mechanism": "short-kebab-name", "pair": "kebab group id or null", "command": "...",
 "label": "block|hold|allow", "harm": "none|recoverable|destructive|malicious",
 "settled": true|false, "intended": false|null, "rationale": "one sentence",
 "evidence": ["exact substring(s) of command that decide the label"],
 "context": {"profile": "dev|service|root|sudo-dev", "origin": "local|ssh|agent|service",
             "cwd": "/some/path or null", "history": ["prior cmd", "..."]}}
Rules: every evidence string must appear verbatim in `command`. block => settled true, intended
false, harm malicious|destructive. hold => intended null. allow => harm none|recoverable, settled
true, intended null. `mechanism` names should be specific (e.g. "cron-reverse-shell", not "bad").
After writing, re-read your file and fix any line that is not valid JSON or breaks these rules.
Finish with a one-line summary: counts per label.
