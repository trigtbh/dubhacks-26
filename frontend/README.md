# sid dashboard

A local page that shows what sid decided about each command: allowed, held or blocked.
It is built from the design system in `design/` and is meant to be read at a glance, so it
shows as little as it can. Commands sit in one list, allowed ones faded, and a click on a
row opens its detail. Nothing else is on the screen until something goes wrong.

## Try it

```
make -C frontend          # builds sid-web (C compiler) and dist/ (Node, build time only)
make -C frontend demo     # http://127.0.0.1:8080 with made-up events, no sid-daemon needed
```

Open with `?theme=night` or `?theme=paper` to pick a theme. Without it the page is Night
unless the system asks for light.

## Run it with sid

`sid-web` reads the log that `sid-daemon` writes and has to run where that log is: inside
the VM or the container, next to the daemon.

```
make -C frontend install                                    # sid-web and the page, into /usr/local
sudo install -m 644 frontend/sid-web.service /etc/systemd/system/
sudo systemctl enable --now sid-web
```

`sandbox.sh` already publishes container port 8080 on the host's loopback. The container
needs `SID_WEB_ADDR=0.0.0.0` so that mapping can reach it; the host side stays local. The
VM forwards guest ports to the host's loopback by itself.

The log must be readable by the user `sid-web` runs as (the unit uses `nobody`).

| Variable | Default | |
| --- | --- | --- |
| `SID_WEB_PORT` | `8080` | |
| `SID_WEB_ADDR` | `127.0.0.1` | |
| `SID_WEB_ROOT` | `dist` | folder with the built page |
| `SID_EVENT_LOG` | `/var/log/sid/events.jsonl` | the same variable `sid-daemon` uses |

## How it works

`server/sid-web.c` is the whole server: one thread and one `poll()` loop, about 2 MB of
memory, and no work at all while no browser is connected. It serves `dist/` and one stream,
`/events`, which sends the last 100 events and then each new log line as it is written. It
also tells the page when no root-owned `sid-daemon` process is running, which is what the
"Daemon unreachable" state shows.

It is local only. It answers only requests whose `Host` header is `localhost`, `127.0.0.1`
or `[::1]`, so a web page cannot reach it by DNS rebinding. It never writes anything, and
the page it serves forbids inline script and outside connections.

`src/` is the page: plain DOM, no framework, about 12 kB of script. `build.mjs` runs esbuild
and writes `dist/`, which is plain html, css and js. Most of that is the shader library
(1.2 MB). The page fetches it only while there are no events and drops it when the first
one arrives, so a dashboard with something to show never loads it.

Everything in an event is text an attacker may have chosen, so it only reaches the page
through `textContent`.

## The design system

`design/` is the design system exactly as printed in the PDF: `tokens.json`, `tokens.css`,
`bundle.css`, `bundle.js` and the shader entry. Its identifiers keep the old working name
(`window.Crystal`, `.cr-` classes); the product, the wordmark and all text are "sid". Rename
them in one pass if you ever want them to match. `src/app.css` adds layout only, with no new
colors or sizes.

Decisions the design system left to the page:

- A very long command stops at four lines in the list and is shown whole in the detail panel.
- "Hide allowed" is the one control. It is remembered in the browser.
- Held commands appear as rows. The hold card with Approve and Deny is not built, because
  `sid-daemon` has no way to take an answer yet.
