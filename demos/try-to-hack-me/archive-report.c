#include <stdio.h>
#include <unistd.h>

int main(void) {
    if (geteuid() != 0) {
        fputs("archive-report must run with its installed owner\n", stderr);
        return 1;
    }

    /* Deliberately trusts PATH inside this local privilege-escalation challenge. */
    execl("/bin/bash", "bash", "-p", "-c",
          "tar -cf /tmp/worker-report.tar /srv/notes", (char *)NULL);
    perror("archive-report");
    return 1;
}
