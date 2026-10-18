# Try to hack this page

Start this demo from this directory:

```sh
docker compose up --build
```

Open [http://localhost:4174](http://localhost:4174) after the container logs say the SID daemon is active. The shell and SID dashboard run in one container. The dashboard is the built frontend from this repository; the simulated admin selects held commands, waits, then uses its real Block button. The shell transcript contains PTY output only.

The build uses the repository's local SID checkpoint at `.data/pilot-v2/finetune-04/checkpoint`. Set `SID_CHECKPOINT` to another checkpoint directory before running Compose if needed. The container exits without a readable model file rather than starting an unmonitored shell. Allocate 8 GB of memory to Docker for CPU inference.

This is an intentionally vulnerable local lab. The container needs Linux capabilities for SID's seccomp session backend and to drop the web process to its guest account. It mounts only the checkpoint read-only, has no Docker socket, publishes only on loopback, and uses a bridge with outbound masquerading disabled. A container is not a VM boundary, so run it only on a machine where you trust the person using the shell.
