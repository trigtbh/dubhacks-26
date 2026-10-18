#pragma once

#include <cstdint>

struct SessionHello {
	uint32_t version;
	uint32_t pid;
};

constexpr uint32_t SID_SESSION_RPC_VERSION = 1;
