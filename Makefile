# Build and install sid-daemon. Linux only; vm/install.sh runs this inside the VM.
PREFIX ?= /usr/local
BUILD  ?= build
CXX    ?= g++
BPFTOOL ?= bpftool
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra -pthread
ARCH   := $(shell uname -m | sed 's/x86_64/x86/;s/aarch64/arm64/')
SRCS   := src/main.cpp src/context.cpp src/event.cpp src/fan.cpp src/decide.cpp \
          src/jev.cpp src/jev_stub.cpp src/unsure.cpp src/review.cpp src/changes.cpp src/enforce.cpp
EXPLORE_SRCS := src/explore_main.cpp src/changes.cpp src/overlay_diff.cpp
TEST_SRCS := tests/test_main.cpp src/changes.cpp src/overlay_diff.cpp src/review.cpp src/unsure.cpp \
             src/jev.cpp src/jev_stub.cpp src/enforce.cpp

.PHONY: all install clean test
all: $(BUILD)/sid-daemon $(BUILD)/sid-explore $(BUILD)/exec_trace.bpf.o

$(BUILD)/sid-explore: $(EXPLORE_SRCS) $(wildcard src/*.hpp)
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $(EXPLORE_SRCS)

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
	install -m 755 $(BUILD)/sid-explore $(PREFIX)/bin/sid-explore
	install -m 644 $(BUILD)/exec_trace.bpf.o $(PREFIX)/lib/sid/exec_trace.bpf.o

# Unit tests. The overlay and whiteout cases need root (they skip otherwise);
# TEST_TMP should be a tmpfs so trusted.overlay xattrs work.
$(BUILD)/sid-tests: $(TEST_SRCS) $(wildcard src/*.hpp)
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ $(TEST_SRCS)

test: $(BUILD)/sid-tests
	$(BUILD)/sid-tests

# The unsure path end to end without the capture; see tests/demo_unsure.cpp.
$(BUILD)/sid-demo-unsure: tests/demo_unsure.cpp src/unsure.cpp src/review.cpp src/changes.cpp src/jev.cpp src/enforce.cpp $(wildcard src/*.hpp)
	mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ tests/demo_unsure.cpp src/unsure.cpp src/review.cpp src/changes.cpp src/jev.cpp src/enforce.cpp

clean:
	rm -rf $(BUILD)
