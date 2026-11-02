#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/bootstrap-worktree.sh /absolute/path/to/source/checkout" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$(git -C "$script_dir" rev-parse --show-toplevel)
source=$(git -C "$1" rev-parse --show-toplevel)
target_git=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)
source_git=$(git -C "$source" rev-parse --path-format=absolute --git-common-dir)

if [ "$source_git" != "$target_git" ]; then
  echo "Source must be another worktree of this repository: $source" >&2
  exit 2
fi

if [ "$source" != "$target" ] && [ -f "$source/.env.local" ]; then
  if [ -e "$target/.env.local" ]; then
    echo "Keeping existing .env.local"
  else
    cp -p "$source/.env.local" "$target/.env.local"
    echo "Copied .env.local from $source"
  fi
else
  echo "No .env.local to copy from $source"
fi

# Install the pinned toolchain before editors or parallel commands use the Rust
# proxies: concurrent first-use installs into the shared ~/.rustup can corrupt it.
(cd "$target" && bin/rustup toolchain install)

"$target/bin/pnpm" install --dir "$target" --frozen-lockfile
