#pragma once
#include "event.hpp"

// decide() gets the fully gathered event and returns a Decision. It is called
// concurrently from many daemon threads (one per paused exec), so it must be
// thread-safe. It may block (exploration, waiting on a person): the daemon
// enforces a timeout and fails closed on a timeout or an exception.
Decision decide(const Event &ev);

// Called once at startup, before capture: start the model and review server.
void decide_init();

// Push the calling handler's answer deadline out (the daemon otherwise denies
// after SID_DECIDE_TIMEOUT). For decisions that wait on a simulation or a person.
// Defined by the daemon; a no-op outside a decide() call.
#include <chrono>
void extend_deadline(std::chrono::milliseconds from_now);
