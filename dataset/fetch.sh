#!/usr/bin/env bash
# Download the raw sources into .data/raw/ (skips files that already exist).
#
#     dataset/fetch.sh                 # every source
#     dataset/fetch.sh nl2bash tldr    # just these
#
# Only curl: git clone is unavailable on the lab machines. Nothing downloaded here is ever
# executed; the loaders read it as data.
set -euo pipefail

RAW="$(cd "$(dirname "$0")/.." && pwd)/.data/raw"
mkdir -p "$RAW"
cd "$RAW"

get() {  # get URL OUT
	[ -s "$2" ] && return
	mkdir -p "$(dirname "$2")"
	curl -sfL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}

head_sha() { curl -sf "https://api.github.com/repos/$1/commits/$2" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["sha"])'; }

fetch_nl2bash() {
	for f in all.cm all.nl; do
		get "https://raw.githubusercontent.com/TellinaTool/nl2bash/master/data/bash/$f" "nl2bash/$f"
	done
}

fetch_tldr() {
	[ -d tldr/common ] && return
	[ -s tldr.rev ] || head_sha tldr-pages/tldr main > tldr.rev
	get "https://codeload.github.com/tldr-pages/tldr/tar.gz/$(cat tldr.rev)" tldr.tar.gz
	mkdir -p tldr
	tar -xzf tldr.tar.gz -C tldr --strip-components=2 --wildcards '*/pages/common/*' '*/pages/linux/*'
	rm tldr.tar.gz
}

fetch_ssh() {
	get https://raw.githubusercontent.com/ML4Net/SSH-Shell-Attacks/main/data/raw/ssh_attacks.parquet ssh/ssh_attacks.parquet
}

fetch_tbench() {
	for f in train-00000-of-00002.parquet train-00001-of-00002.parquet; do
		get "https://huggingface.co/datasets/yoonholee/terminalbench-trajectories/resolve/main/data/$f" "tbench/$f"
	done
}

# One YAML per technique, listed from the git tree. On the lab machines something kills curl
# while it downloads these files (signal 9), so this source may have to be fetched elsewhere and
# copied into .data/raw/art/.
fetch_art() {
	[ -s art.rev ] || head_sha redcanaryco/atomic-red-team master > art.rev
	local rev
	rev="$(cat art.rev)"
	if [ ! -s art.list ]; then
		curl -sf "https://api.github.com/repos/redcanaryco/atomic-red-team/git/trees/$rev?recursive=1" |
			python3 -I -c '
import json, re, sys
for x in json.load(sys.stdin)["tree"]:
    if re.fullmatch(r"atomics/(T[\d.]+)/\1\.yaml", x["path"]):
        print(x["path"])' > art.list
	fi
	mkdir -p art
	while read -r p; do
		get "https://raw.githubusercontent.com/redcanaryco/atomic-red-team/$rev/$p" "art/$(basename "$p")" ||
			echo "art: failed $p" >&2
	done < art.list
}

for s in "${@:-nl2bash tldr ssh tbench art}"; do
	for one in $s; do
		echo "fetch $one" >&2
		"fetch_$one"
	done
done
