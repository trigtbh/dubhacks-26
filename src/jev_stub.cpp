// Placeholders until the JEV model is linked in. Weak, so the real
// definitions win without editing this file.
#include "jev.hpp"

__attribute__((weak)) void jev_init() {}

__attribute__((weak)) std::string jev_classify(const Event &ev)
{
	(void)ev;
	return R"j({"choice":"allow","reason":"no JEV model linked; allowing (stub)"})j";
}
