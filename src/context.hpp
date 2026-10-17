#pragma once
#include "event.hpp"
#include "exec.h"

// Phase 2: gather context for a paused exec. All passive reads of /proc and the
// event fd. Nothing here may exec a program: while the capture is live, the
// child would pause on itself.
size_t load_package_files();  // dpkg's installed files, used to tell whether a binary is new

// `rec` is the matched eBPF record, or null if none arrived in time.
void gather(Event &ev, uint32_t tid, int efd, const char *role, const exec_rec *rec);
