#!/bin/bash
# One-command installer for sid on a fresh Debian/Ubuntu host.
#
#   curl -fsSL https://raw.githubusercontent.com/trigtbh/dubhacks-26/main/linux/bootstrap.sh | sudo bash
#
# Pass options through to the build after `--`, for example a GPU build with the
# dashboard:
#
#   curl -fsSL .../bootstrap.sh | sudo bash -s -- --gpu --with-dashboard
#
# This installs the build and model dependencies, clones the repository, fetches
# the bundled checkpoint over Git LFS, and runs linux/install.sh. Override the
# source with the SID_REPO, SID_REF, and SID_DEST environment variables.
set -euo pipefail

REPO="${SID_REPO:-https://github.com/trigtbh/dubhacks-26}"
REF="${SID_REF:-main}"
DEST="${SID_DEST:-/opt/sid/src}"

if [ "$(id -u)" -ne 0 ]; then
	echo "bootstrap.sh must run as root (pipe it into 'sudo bash')" >&2
	exit 1
fi

# Build and model dependencies. Skipped on hosts without apt-get, where they are
# assumed to be present already.
if command -v apt-get >/dev/null 2>&1; then
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y build-essential clang llvm bpftool libbpf-dev libelf-dev \
		zlib1g-dev linux-tools-common linux-tools-generic python3-venv nodejs npm \
		git git-lfs curl
fi
git lfs install --skip-repo

# Clone fresh, or update an existing checkout in place.
if [ -d "$DEST/.git" ]; then
	git -C "$DEST" fetch --depth 1 origin "$REF"
	git -C "$DEST" checkout -f "$REF"
	git -C "$DEST" reset --hard "origin/$REF"
else
	mkdir -p "$(dirname "$DEST")"
	git clone --depth 1 --branch "$REF" "$REPO" "$DEST"
fi
git -C "$DEST" lfs pull

# Hand off to the host installer. --venv builds the model runtime; any extra
# arguments (for example --gpu or --with-dashboard) are passed straight through.
exec bash "$DEST/linux/install.sh" "$DEST" --venv "$@"
