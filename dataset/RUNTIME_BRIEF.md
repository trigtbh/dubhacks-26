# Runtime changes for the decision model (brief for whoever owns src/)

The decision model is trained on rendered Event JSON (see `dataset/MODEL_INPUT.md`). These changes
make the live Event carry what the model was trained to read. Ordered by value for effort. Each is
independent. All of them are proposals: check with the team before changing shared behaviour.

Constraint to keep in mind: `gather()` runs while the exec is paused and must not exec anything
(the child would pause on itself). Anything that needs a program (`sudo -l`) has to run in
`decide_init()` / startup, before the capture goes live.

## Command-review integration point

The `command-review` branch already routes model Allow/Block decisions and handles Hold
with simulation and human review. Its model entry points are `jev_init()` and
`jev_classify(const Event&)` in `src/jev.hpp`; weak definitions in `src/jev_stub.cpp`
currently always allow. Laya should replace those definitions while keeping this review
flow. [MODEL_INPUT.md](MODEL_INPUT.md#command-review-model-hook) specifies rendering,
initialization, concurrency and the expected output JSON. The selected local checkpoint is
`.data/pilot-v2/finetune-04/checkpoint/`; it remains disconnected from the daemon.

## 1. Permission fields (small)

Add a `perms` object to `Event::to_json()`:

- `groups`: names via `getgrgid_r` for each gid already in `ev.groups`.
- `account`: `root` if uid 0; `service` if uid < `UID_MIN` (default 1000, `/etc/login.defs`) or the
  passwd shell is `nologin`/`false`; else `human`.
- `caps`: parse `CapEff` (hex) from `/proc/<pid>/status` (`status_field` already reads it) into
  names (`cap_sys_admin`, `cap_net_raw`, ...). Root usually shows all of them; render that as `all`.
- `under_sudo`: any `parent_chain` exe whose basename is `sudo` or `doas`.
- `sudo`: per user, computed once at startup with `sudo -n -l -U <user>` for each user in
  `/etc/passwd`, classified as `none` / `some` / `all (password)` / `all (nopasswd)`; `unknown` if
  it fails. Cache in a map; no refresh needed for the demo.

Done when: a test exec from a docker-group user shows `"groups":[..., "docker"]`, and `sudo ls`
shows `"under_sudo":true`.

## 2. History that means "what this actor ran" (small)

`recent` today is the last 5 execs for the `sessionid`. Two problems:

- **Shared key.** Processes outside a login session (systemd services, an agent started by one)
  all have the same sessionid (`-1` / `4294967295`), so they share one history. Key by: sessionid
  if valid, else the nearest agent ancestor's pid, else the service name, else the ppid.
- **Subprocess noise.** `make` → `cc` → `as` all land in history. Only record an exec when its
  parent is a shell (`bash`, `sh`, `dash`, `zsh`) or an agent. Children of other programs are still
  decided on; they just don't enter the history.

Done when: two services' commands no longer show up in each other's `recent`, and `make` in a
project adds one history entry, not dozens.

## 3. Longer captured arguments (moderate, eBPF)

`SID_ARGLEN` is 256 and `SID_MAXARGS` 32 (`src/exec.h`). Agents send whole scripts as
`bash -c '<line>'`, which gets cut at 256 bytes, so the model sees the start of a heredoc and
nothing after. Target: at least 4 KB for the arg after `-c`, 8 KB total. The eBPF stack is 512
bytes, so the record must move to a per-CPU array map (or ring buffer reservation) instead of the stack.

Done when: `bash -c "<3 KB python heredoc>"` arrives untruncated with `truncated:false`.

## 4. Parent command line (small)

Add `parent_cmdline`: the `/proc/<pid>/cmdline` of the nearest shell in `parent_chain` (NUL → space,
cap 1 KB). A child exec (`curl`, `rm`) then shows the agent's full `bash -c` line it came from, so
it can be judged in context instead of alone.

## 5. Typed lines for interactive shells (larger, optional)

Over SSH the user types into a shell that is already running. Builtins (`echo`, `cd`, `export`,
redirections) never exec, so `echo "root:pw" | chpasswd` arrives as just `chpasswd`, and the typed
text is gone. A uretprobe on bash's `readline()` captures each entered line; attach the latest line
of that shell's session to its following execs as `line`. zsh needs a separate probe (zle), so bash
alone is fine for the demo.

## Known limit (not fixable by formatting)

A command that never execs is never paused, so `decide()` never sees it:
`echo "ssh-rsa AAAA…" >> ~/.ssh/authorized_keys` is pure builtins plus a redirect. #5 makes such
lines visible (for logging or alerting) but they cannot be held. This belongs in the security
assumptions of the demo.
