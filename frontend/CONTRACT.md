# sid data contract

Source of truth for what the daemon (or the dev simulator in `sim/`) writes to `events.jsonl`, what `sid-web` streams, and what the page
sends back. The page, `server/sid-web.c` and `sim/` are all built against this file.


**Transport.** `events.jsonl` (`SID_EVENT_LOG`): one JSON object per line, UTF-8, `\n`-terminated, ≤128 KiB, one `write`
on an `O_APPEND` fd. Both layouts `"id":"x"` and `"id": "x"` are valid. Reserved top-level keys `id`, `verdict`, `q`
(never nested, because sid-web's scanner is nesting-unaware). A line with `q` is a quarantine line; otherwise a line with
`verdict` is an event line. `time` is ISO-8601 ms `+00:00`; every other time is epoch ms UTC (`t`, `ends_at`, `now`). The hold
line is always written before any `q` line of that id; `seq` is per id, starts at 1 on `q:start`, contiguous, `q:end` last.

**Event line** = today's daemon fields unchanged (`id` 12 hex, `time`, `uid`, `gid`, `groups[]`, `user`, `cwd`, `path`,
`argv[]`, `origin{type,detail}`, `via_ssh`, `recent[]`, `verdict`, `decided_by`, `reason`, `score`, `effects`, `attack_id`,
`latency_ms`, …) plus optional `model`, `context`, `sim:true` (simulator only; the page ignores it).
`decided_by ∈ stub|model|rule|exploration|classifier|person|timeout|restart`. `verdict` is the final decision and may
differ from `model.choice` (rule override).

**`model`** = `{"choice":"allow|hold|block","probabilities":{"allow":0.97,"hold":0.02,"block":0.01}}`, each in [0,1] to 4 dp,
sum 1 ±0.001. `choice` is authoritative. `choice` is the most likely outcome (the largest probability); a held command can be close to 100% hold.

**Settle line** = event line with the same `id` as a hold: `{"id","time","verdict":"allow|block","decided_by":"person|timeout|restart","reason"}`.
First valid settle per id wins; settles for ids never held are dropped by the server. Browser merges over the hold row,
keeps the hold's `time`.

**Quarantine lines** (common: `q`, `id`, `seq`, `t`):
- `q:start` `{duration_ms, ends_at, limits:{out_events:200,out_bytes:32768,file_events:200}}`
- `q:out` `{stream:"stdout"|"stderr", data (≤2 KiB, may split mid-line), trunc?:true}`. Invalid UTF-8 → U+FFFD; ANSI/control chars left intact; the page strips them for display.
- `q:file` `{op:"create|modify|delete|move|chmod", path (abs), to? (move), bytes? (create/modify), mode? ("0777", chmod)}`
- `q:end` `{how:"exit|signal|timeout|aborted|error", code, signal, elapsed_ms, counts:{create,modify,delete,move,chmod,stdout_bytes,stderr_bytes,dropped_out,dropped_files}, touched:[≤8 sensitive paths, byte-sorted], summary}`
- Producer caps per hold: ≤200 `q:out` and 32 KiB total, ≤200 `q:file` (sensitive paths always emitted up to +50), ≤20 q lines/s/id
  (coalesce in 100 ms windows). Overflow counted in `dropped_*`.

**Deterministic summary** (pure function of counts, touched, how, code, signal, duration_ms):
`S1` = no ops → "In the quarantine it changed no files." else "In the quarantine it " + join_and(phrases) + "." where phrases are
`created N file(s)`, `modified…`, `deleted…`, `moved…`, `changed permissions on…` (only counts >0, in that order);
`S2` = touched non-empty → "Sensitive paths touched: " + first 3 (+ " and N more") + "." (control chars → `?`, cut at 120 chars + `…`);
`S3` = exit 0 "It exited normally." | exit≠0 "It exited with code N." | signal "It was stopped by signal NAME." |
timeout "It was still running after S seconds and was stopped." | aborted "It was stopped early because a decision was made." |
error "The quarantine failed to run it." `summary = join(" ", nonempty[S1,S2,S3])`.
Sensitive path rules: `^/etc/ ^/boot/ ^/root/ ^/proc/sys ^/sys/ ^/(usr/(local/)?)?(s?bin|lib|lib64)/ ^/var/spool/cron/ ^/var/log/
^/home/[^/]+/\.(ssh|gnupg|aws|kube)/ ^/home/[^/]+/\.(bashrc|bash_profile|profile|zshrc|zprofile)$ /authorized_keys$ ^/dev/(sd|nvme|vd)`.
Golden vectors in `sim/golden/summary.json` (zero ops; create 1; create 2 + chmod 1 exit 2; five kinds + 5 touched → "A, B, C and 2 more"; timeout 12 s).

**`context` string** (exact format, nine header lines in this order, then history header, then ≥0 lines indented two spaces):
```
command: <argv joined, or path>
program: <abs path>
origin: <local|ssh|service|agent>[ (<detail>)]
user: <name> (uid <n>[, <human|service|root> account])
groups: <name, name | none>
sudo rights: <none|some|all (password)|all (nopasswd)|unknown>
capabilities: <none|all|cap_x[, cap_y]*>
cwd: <abs path>
files (inferred): <none | op path[; op path]*>      op = read|write|delete|perms
history (oldest first):
  <command>      (≤5 lines)
```
Writer escapes C0 controls/DEL as `\n \r \t \xNN` in every value, ≤16 files then `(+N more)`, ≤8 KiB total.
**Parser is strict and positional**: any deviation (forged `origin:` via raw LF, missing/extra line) invalidates the whole
context → fall back to synthesized form and mark `suspect`. A context that conflicts with structured `user`, `origin`, or
`argv` also falls back completely; context-only fields are not attached to a different command. Structured fields stay the
source of truth. **Fallback synthesis** for lines without a valid context (today's daemon): command = argv/path;
program = `path` only (the executable path is not guessed from a target file or `argv[0]`); origin = origin.type+detail
(local+`via_ssh` → ssh); user = `name (uid N)`; a numeric UID fallback is not shown as an account name; account type is unknown
unless an inspected context explicitly records it;
groups = numeric gids; sudo and capabilities = `unknown`; cwd; files = none; history = `recent`.

**SSE `GET /events`.** Default frames `data: <line verbatim>`, `id: <byte offset after line>`, `Last-Event-ID` resume.
`event: clock` `{"now":ms,"decide":bool}` sent first on every connect and every 15 s (replaces `: ping`); `decide:false` when
the decisions file isn't writable. `event: status` `up|down` unchanged. Fresh-connect backlog = last 1000 primary lines (hold,
block, settle) plus every `q` line of known held ids, in log order. Server drops: allow lines whose id isn't held; `q` lines
whose id isn't held; lines >256 KiB. Lines with neither verdict nor `q` still pass (today's behavior; the page ignores them).

**Decision channel `POST /decide`**: headers `Content-Type: application/json` (exact), `X-Sid-Request: 1`, `Content-Length ≤512`
(no chunked); body `{"id","verdict":"allow|block"}`. Server order of checks: content-type → custom header → same-origin
(`Origin` must equal `http://<Host>`, `null` rejected; `Sec-Fetch-Site` must be `same-origin`; neither present passes, for curl) →
parse (`id` `[A-Za-z0-9_-]{1,32}`) → id is a known held id (404) not settled (409) → duplicate ring (same verdict = 202
`duplicate:true`, different = 409) → append one line `{"v":1,"id","verdict","t","peer"}` to `SID_DECISION_LOG` (default
`/var/log/sid/decisions.jsonl`, `O_APPEND`, 503 if >8 MiB or unwritable). Replies: 202 `{ok,queued,id,verdict}`, 400, 403, 404, 405
(no CORS, no OPTIONS), 409, 411/413/415, 503; all `Cache-Control: no-store`. The row changes only when the settle line arrives.
Daemon obligations (future): treat the file as untrusted; first valid decision per id wins; end a running quarantine early with
`q:end how:"aborted"`; after `ends_at` + grace with no decision write a `block` settle with `decided_by:"timeout"`; truncate in place.

**Browser rules.** Dedupe by `lastSeq[id]` (jump >1 applies and marks output "may be incomplete"; q lines for unknown ids ignored).
Countdown: `skew = clock.now - Date.now()` per clock frame; anchor on `performance.now()`; progress from `duration_ms`/`ends_at`,
never receipt time (reload mid-flight is correct). Countdown at 0 with no `q:end`: "Finishing…" for 5 s, then `noreport`
("No report from the quarantine"), never a fabricated summary; Allow/Block enabled with a dashed marker; `status:down` →
interrupted immediately; a late `q:end` still applies. Render caps: last 500 output lines / 64 KiB per quarantine.

