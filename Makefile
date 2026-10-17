# Build and install sid-daemon. Linux only; vm/install.sh runs this inside the VM.
PREFIX ?= /usr/local
BUILD  ?= build
CXX    ?= g++
BPFTOOL ?= bpftool
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra -pthread
ARCH   := $(shell uname -m | sed 's/x86_64/x86/;s/aarch64/arm64/')
SRCS   := src/main.cpp src/context.cpp src/event.cpp src/fan.cpp src/decide.cpp

.PHONY: all install clean
all: $(BUILD)/sid-daemon $(BUILD)/exec_trace.bpf.o

$(BUILD)/vmlinux.h:
	mkdir -p $(BUILD)
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

$(BUILD)/exec_trace.bpf.o: src/exec_trace.bpf.c src/exec.h $(BUILD)/vmlinux.h
	clang -g -O2 -target bpf -D__BPF__ -D__TARGET_ARCH_$(ARCH) -I$(BUILD) -Isrc -c $< -o $@

$(BUILD)/sid-daemon: $(SRCS) $(wildcard src/*.hpp src/*.h)
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $(SRCS) -lbpf -lelf -lz

install: all
	install -d $(PREFIX)/bin $(PREFIX)/lib/sid
	install -m 755 $(BUILD)/sid-daemon $(PREFIX)/bin/sid-daemon
	install -m 644 $(BUILD)/exec_trace.bpf.o $(PREFIX)/lib/sid/exec_trace.bpf.o

clean:
	rm -rf $(BUILD)
