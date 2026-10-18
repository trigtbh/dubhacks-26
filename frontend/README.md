# sid dashboard

A local page for commands sid blocked or held. Every context value has a visible field label;
model probabilities show their values and outcome names beside geometric marks. Missing fields
are shown as not recorded. The page reads the event log and has no built-in sample records.

A click on a row opens its detail. Until something is blocked or held, the page shows a
plain empty state on a flat background.

## Run it

The page is built once, on a machine with Node. The server then runs where the log is, next
to `sid-daemon`, and needs only a C compiler.

```
make -C frontend dist      # on the host: builds the page into frontend/dist
```

To see a populated demo with twelve probability examples, build the local server and run the
fake-data simulator (from the `frontend` directory):

```
make dist server
node sim/sim.mjs --scenario probabilities --clean --serve
```

The simulator writes only to `sim/.run/`; its events are sample data, not live sid decisions.

In the Docker sandbox, `./sandbox.sh` builds the page when Node.js is installed, starts
the web server before capture initialization, and prints its URL when it responds. If
capture startup fails, the dashboard stays available and SSH stays off. On a host without
Node.js, an existing `frontend/dist` can still be served; otherwise install Node.js and
run `make -C frontend dist`. Rebuild and restart with `./sandbox.sh --build`.

In the Docker sandbox, sid gates commands launched by SSH sessions inside the container.
The image is built for the Docker host's native architecture (including `linux/arm64` on
Apple Silicon); it does not use x86 emulation. Standalone Linux installs use fanotify and
eBPF to capture system-wide execs.

To keep it running, `make install` copies `sid-web` and the page into `/usr/local`, and
`sid-web.service` runs it as an unprivileged user next to `sid.service`.

If the log cannot be read, `sid-web` says so on stderr instead of showing an empty page. The
log must be readable by the user it runs as.

| Variable | Default | |
| --- | --- | --- |
| `SID_WEB_PORT` | `8080` | |
| `SID_WEB_ADDR` | `127.0.0.1` | |
| `SID_WEB_ROOT` | `dist` | folder with the built page |
| `SID_EVENT_LOG` | `/var/log/sid/events.jsonl` | the same variable `sid-daemon` uses |
| `SID_DECISION_LOG` | `/var/log/sid/decisions.jsonl` | where `POST /decide` appends a person's answer; the file must already exist and be writable |
| `SID_REVIEW_SOCK` | `/run/sid/review.sock` | private daemon socket used for decisions and live simulation summaries |

Open the page with `?theme=night` or `?theme=paper` to pick a theme. Without it the page is
Night unless the system asks for light.

## What it keeps

Blocked and held commands. An allowed command is dropped by `sid-web` before it reaches the
browser. The selected command shows labeled event and context fields, quarantine output and file
changes when available, and the model's three probabilities when they were recorded.

The allowed line that settles a held command is kept with the hold. When a report is ready, the
detail panel's Allow and Block buttons write a decision for that held ID. The row updates in
place and keeps its original time. An allowed line whose ID was never held is dropped.

## How it works

`server/sid-web.c` is the whole server: one thread and one `poll()` loop, about 2 MB of
memory, and no work at all while no browser is connected. It serves `dist/` and one stream,
`/events`, which sends the last 1000 blocked, held and settled lines (and the quarantine lines
of held commands) and then each new log line as it is written. While a browser is connected, it
also reads pending ReviewQueue summaries every 500 ms and sends simulation progress and final
reports to the page. It reads the log's two layouts (`"id":"x"` and `"id": "x"`). It also tells the page
when no root-owned `sid-daemon` process is running, which is what the "Daemon unreachable"
state shows.

It is local only. It answers only requests whose `Host` header is `localhost`, `127.0.0.1`
or `[::1]`, so a web page cannot reach it by DNS rebinding. The only thing it writes is one
line per Allow or Block click, appended to `SID_DECISION_LOG` by `POST /decide`, and it
rejects that from any other web page; it never touches the event log. The page it serves
forbids inline script and outside connections.

`src/` is the page: plain DOM, no framework. `build.mjs` runs esbuild and writes `dist/`,
which is plain HTML, CSS, JavaScript, and the fonts used by the page. The background stays flat;
elements fade in or out, and no decorative shapes float behind the content.

Everything in an event is text an attacker may have chosen, so it only reaches the page
through `textContent`.

## The design system

`design/` contains the design system files: `tokens.json`, `tokens.css`, `bundle.css`,
`bundle.js` and the shader entry. The dashboard does not load the shader. Its identifiers keep the old working name
(`window.Crystal`, `.cr-` classes); the product, the wordmark and all text are "sid". Rename
them in one pass if you ever want them to match. `src/app.css` adds layout only, with no new
colors or sizes.

Decisions the design system left to the page:

- A very long command is clamped in the list and shown whole in the detail panel.
- Labeled context fields and log content scroll within the detail panel.
- Allow and Block controls appear when a held command has a report ready.
