#pragma once
#include "event.hpp"

// THIS IS WHERE THE LAYA MODEL PLUGS IN.
//
// decide() gets the fully gathered event and returns a Decision. It is called
// concurrently from many daemon threads (one per paused exec), so it must be
// thread-safe. It may block (exploration, waiting on a person): the daemon
// enforces a timeout and fails closed on a timeout or an exception.
Decision decide(const Event &ev);

// Called once at startup, before the capture goes live: load honeytokens, the
// tiny classifier and Laya here.
void decide_init();
