// Inspect the real model hook without installing kernel capture or running argv.
//   build/sid-model-check -- bash -c 'cat README.md'
#include "jev.hpp"

#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <stdexcept>
#include <thread>
#include <vector>

int main(int argc, char **argv)
{
	try {
		jev_init();
		Event event;
		event.user = "dev";
		event.uid = getuid();
		event.gid = getgid();
		event.cwd = "/workspace";
		event.origin_type = "agent";
		for (int i = argc > 1 && std::string(argv[1]) == "--" ? 2 : 1; i < argc; i++)
			event.argv.push_back(argv[i]);
		if (event.argv.empty()) event.argv = {"true"};
		event.path = event.argv[0];
		const char *parallel = getenv("SID_CHECK_PARALLEL");
		int count = parallel ? std::stoi(parallel) : 1;
		if (count < 1 || count > 128) return 2;
		std::atomic<bool> failed{false};
		std::vector<std::thread> threads;
		for (int i = 0; i < count; i++) threads.emplace_back([&, i] {
			try {
				Event ev = event;
				ev.id = std::to_string(i);
				std::string json = jev_classify(ev);
				JevResult result;
				std::string error;
				if (!parse_jev_json(json, result, &error)) throw std::runtime_error(error);
				puts(jev_json(result).c_str());
			} catch (const std::exception &e) {
				fprintf(stderr, "%s\n", e.what());
				failed = true;
			}
		});
		for (auto &thread : threads) thread.join();
		return failed ? 1 : 0;
	} catch (const std::exception &e) {
		fprintf(stderr, "%s\n", e.what());
		return 1;
	}
}
