# sid simulator (DEV ONLY: FAKE DATA)

A fake daemon and fake traffic generator so the dashboard can be built and demoed before the real daemon
writes `model`, `context`, quarantine lines or reads approvals. It prints `SIMULATOR: FAKE DATA, dev only` on
stderr, tags every line `"sim":true`, and is never imported by `build.mjs` or shipped in `dist/`. Zero
dependencies, Node 22 or newer. It refuses any path under `/var/log/sid` unless `--really-write-real-log` is given.

## Demo

```
node sim/sim.mjs --scenario showcase --serve      # prints http://127.0.0.1:8080/ (needs `make server` and a built dist/)
node sim/sim.mjs --scenario probabilities --clean --serve  # fixed model probability examples
```

Or run the server yourself with `SID_EVENT_LOG=sim/.run/events.jsonl SID_DECISION_LOG=sim/.run/decisions.jsonl`.

The probability scenario sends four commands with explicit, valid model probability distributions: a high-confidence
block, a closer block, and rule overrides where the model preferred Hold or Allow. These values are sample data for
the interface and are not produced by the real daemon. The showcase begins with these same samples.

The showcase sends four blocks, then a hold (`npm install`) that waits for you: watch its quarantine run, then
click Allow or Block when the report appears. A second hold (a "helpful" installer that touches `.ssh`, cron and
`.bashrc`) finishes by itself and gets blocked. Then a burst of blocks. Decide early to see the quarantine abort.

`node sim/sim.mjs --loop` is endless traffic: about 70% allow lines (the server drops them), 20% block, 8% hold
with a full quarantine, 2% hostile text (HTML, ANSI, RTL, zero-width, a forged JSON line). Mean gap 3 s.

## Options

`--scenario showcase|probabilities|list`, `--loop`, `--log PATH`, `--decisions PATH` (defaults `sim/.run/events.jsonl` and
`sim/.run/decisions.jsonl`), `--decide manual|auto:allow|auto:block|auto:alternate` (beats the scenario's choice),
`--hold-timeout SECS` (grace after `ends_at` before an undecided hold is blocked with `decided_by:"timeout"`,
default 300), `--layout compact|spaced|mixed` (C++ style or Python style JSON), `--seed N`, `--clean` (empty both
files first), `--quiet`, `--serve [--bin PATH]`.

## What the fake daemon does

Appends one line per `write` (event lines with every real daemon field plus `model`, `context`, `sim`); for a hold
it writes the hold line (no `reason`), `q:start` (12 s), interleaved `q:out`, `q:file` (create, modify, delete,
move, chmod) and `q:end` with counts, `touched` and the deterministic summary; the producer caps are 200
`q:out` and 32 KiB, 200 `q:file` (+50 sensitive), 100 ms coalescing. It tails the decisions file (100 ms poll,
untrusted input: whole small JSON lines `{"v":1,"id","verdict"}` for held ids only, first valid decision wins),
waits 150 to 400 ms and writes the settle line. A decision during a running quarantine ends it first with
`q:end how:"aborted"`. No decision by `ends_at` plus the grace writes a `block` settle, `decided_by:"timeout"`.

Not implemented (cut for time): other scenarios, golden files, `--check`, virtual clock, `--bulk`, rotation,
fake `/proc`, producer rate limiting beyond coalescing, a strict reference context parser.
