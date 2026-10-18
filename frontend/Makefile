# Build the sid dashboard: the web server (C) and the page (esbuild into plain html, css, js).
# The server needs only a C compiler. The page needs Node, and only to build it, so the two can
# be built on different machines: the VM mounts this folder and builds just the server.
#   make          build both (needs Node)
#   make server   build only the web server
#   make run      build the server and serve the real log (/var/log/sid/events.jsonl)
#   make test     build the server, then run the tests (Node, nothing to install)
#   make asan     build the server with the address and undefined-behavior checkers, into
#                 build/test/sid-web; `make test-asan` runs the tests against that build
#   make install  sid-web to PREFIX/bin and the page to PREFIX/share/sid/web
PREFIX ?= /usr/local
CC     ?= cc
CFLAGS ?= -O2 -std=gnu11 -Wall -Wextra

# One binary per OS and CPU: the VM and the host share this folder.
BIN := build/$(shell uname -s)-$(shell uname -m)/sid-web

ASAN := build/test/sid-web

.PHONY: all server asan test test-asan run install clean
all: server dist
server: $(BIN)
asan: $(ASAN)

$(BIN): server/sid-web.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) -o $@ $<

$(ASAN): server/sid-web.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined -o $@ $<

test: server
	node --test test/

test-asan: asan
	SID_WEB_BIN=$(CURDIR)/$(ASAN) node --test test/

node_modules: package-lock.json
	npm ci --no-audit --no-fund
	@touch $@

dist: node_modules build.mjs $(wildcard src/* design/* design/shader/*)
	node build.mjs
	@touch $@

run: server
	@test -f dist/index.html || { echo "run: build the page first with 'make dist', on a machine with Node" >&2; exit 1; }
	SID_WEB_ROOT=dist $(BIN)

install: server
	@test -f dist/index.html || { echo "install: build the page first with 'make dist', on a machine with Node" >&2; exit 1; }
	install -d $(PREFIX)/bin $(PREFIX)/share/sid/web/fonts
	install -m 755 $(BIN) $(PREFIX)/bin/sid-web
	install -m 644 $(filter-out dist/fonts,$(wildcard dist/*)) $(PREFIX)/share/sid/web/
	install -m 644 dist/fonts/* $(PREFIX)/share/sid/web/fonts/

clean:
	rm -rf dist build
