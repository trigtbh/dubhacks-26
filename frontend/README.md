# sid dashboard

A local page that shows the commands sid blocked or held, and the held ones a person later
approved. Allowed commands are not kept. It is built from the design system in `design/`
and shows only what is in the log: there is no sample data.

A click on a row opens its detail. Until something is blocked or held, the page shows a
plain empty state on a flat background.

## Run it

The page is built once, on a machine with Node. The server then runs where the log is, next
to `sid-daemon`, and needs only a C compiler.

```
make -C frontend dist      # on the host: builds the page into frontend/dist
```

In the VM (`./vm.sh` opens a shell; the repo is mounted at `/workspace`):

```
cd /workspace/frontend && make run
```

Then open http://127.0.0.1:8080 on the host. The VM forwards the port by itself.

In the container, `sandbox.sh` already publishes port 8080 on the host's loopback. The
server has to listen on all of the container's addresses for that to reach it:

```
SID_WEB_ADDR=0.0.0.0 make -C /workspace/frontend run
```

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

Open the page with `?theme=night` or `?theme=paper` to pick a theme. Without it the page is
Night unless the system asks for light.

## What it keeps

Blocked and held commands. An allowed command is dropped by `sid-web` before it reaches the
browser, so a busy machine costs the page nothing.

The one allowed line that is kept is the one that settles a held command. `sid-daemon` does
not take approvals yet. When it does, write the decision to the log as another event with
the same `id` as the hold, and `verdict` set to `allow` for an approval or `block` for a
denial. The held row then changes in place: its chip morphs, it says "Approved" or gives the
block reason, and it keeps its spot and time. An allowed line whose `id` was never held is
dropped.

## How it works

`server/sid-web.c` is the whole server: one thread and one `poll()` loop, about 2 MB of
memory, and no work at all while no browser is connected. It serves `dist/` and one stream,
`/events`, which sends the last 1000 blocked, held and settled lines (and the quarantine lines
of held commands) and then each new log line as it is written. It reads the log's two layouts (`"id":"x"` and `"id": "x"`). It also tells the page
when no root-owned `sid-daemon` process is running, which is what the "Daemon unreachable"
state shows.

It is local only. It answers only requests whose `Host` header is `localhost`, `127.0.0.1`
or `[::1]`, so a web page cannot reach it by DNS rebinding. The only thing it writes is one
line per Allow or Block click, appended to `SID_DECISION_LOG` by `POST /decide`, and it
rejects that from any other web page; it never touches the event log. The page it serves
forbids inline script and outside connections.

`src/` is the page: plain DOM, no framework. `build.mjs` runs esbuild and writes `dist/`,
which is plain HTML, CSS, JavaScript, and the fonts used by the page. No animated background
shader or floating background shapes are loaded.

Everything in an event is text an attacker may have chosen, so it only reaches the page
through `textContent`.

## The design system

`design/` contains the design system files: `tokens.json`, `tokens.css`, `bundle.css`,
`bundle.js` and the shader entry. The dashboard does not load the shader. Its identifiers keep the old working name
(`window.Crystal`, `.cr-` classes); the product, the wordmark and all text are "sid". Rename
them in one pass if you ever want them to match. `src/app.css` adds layout only, with no new
colors or sizes.

Decisions the design system left to the page:

- A very long command stops at four lines in the list and is shown whole in the detail panel.
- The page scrolls as one, with the detail panel pinned beside the list, so nothing is cut off.
- The hold card with Approve and Deny is not built, because `sid-daemon` has no way to take
  an answer yet.
