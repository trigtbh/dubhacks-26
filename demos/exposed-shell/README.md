# Exposed shell

Start this demo from this directory:

```sh
docker compose up --build
```

Open [http://localhost:4173](http://localhost:4173) after the container logs say the SID daemon is active. The notebook console is attached to a real Python process; `exit()` returns to Bash. SID evaluates executed programs through its seccomp session backend. If SID blocks an execution, the page shows only the shell's PTY output.

The build uses the repository's local SID checkpoint at `.data/pilot-v2/finetune-04/checkpoint`. Set `SID_CHECKPOINT` to another checkpoint directory before running Compose if needed. The container exits without a readable model file rather than starting an unmonitored shell. Allocate 8 GB of memory to Docker for CPU inference.

This is an intentionally vulnerable local lab. The container needs Linux capabilities for SID's seccomp session backend and to drop the web process to its guest account. It mounts only the checkpoint read-only, has no Docker socket, publishes only on loopback, and uses a bridge with outbound masquerading disabled. A container is not a VM boundary, so run it only on a machine where you trust the person using the shell.
