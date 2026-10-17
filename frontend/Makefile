# Build the sid dashboard: the web server (C) and the page (esbuild into plain html, css, js).
# The server needs only a C compiler. The page needs Node, and only to build it.
#   make          build both
#   make demo     serve made-up events at http://127.0.0.1:8080, no sid-daemon needed
#   make run      serve the real log (/var/log/sid/events.jsonl, readable on Linux with sid running)
#   make install  sid-web to PREFIX/bin and the page to PREFIX/share/sid/web
PREFIX ?= /usr/local
CC     ?= cc
CFLAGS ?= -O2 -std=gnu11 -Wall -Wextra

.PHONY: all demo run install clean
all: sid-web dist

sid-web: server/sid-web.c
	$(CC) $(CFLAGS) -o $@ $<

node_modules: package-lock.json
	npm ci --no-audit --no-fund
	@touch $@

dist: node_modules build.mjs $(wildcard src/* design/* design/shader/*)
	node build.mjs
	@touch $@

demo: all
	./demo.sh

run: all
	SID_WEB_ROOT=dist ./sid-web

install: all
	install -d $(PREFIX)/bin $(PREFIX)/share/sid/web/fonts
	install -m 755 sid-web $(PREFIX)/bin/sid-web
	install -m 644 $(filter-out dist/fonts,$(wildcard dist/*)) $(PREFIX)/share/sid/web/
	install -m 644 dist/fonts/* $(PREFIX)/share/sid/web/fonts/

clean:
	rm -rf dist sid-web
