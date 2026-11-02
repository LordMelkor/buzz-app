# Buzz's own copy of Codex, apart from any `codex` the user installed.
# The plugin runs it as `bash -c` (see `withScript` in setup.ts), each time
# with one of these steps:
#
#   run [ARGS...]                  runs the copy in use with ARGS, in Buzz's home
#   install VERSION TARGET SHA256  downloads a release and checks it
#   use VERSION                    makes a downloaded release the one in use
#   adopt THREAD                   copies a thread Buzz saved in the user's
#                                  Codex home into Buzz's
set -eu

# Shared by every Buzz build on this computer, so there is one download.
if [ "$(uname)" = Darwin ]; then
  dir="$HOME/Library/Application Support/Buzz/codex"
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/buzz/codex"
fi
# Versions name folders, so only digits and dots: no `..` or `/` escapes.
valid() {
  case "$1" in "" | [!0-9]* | *[!0-9.]*) return 1 ;; esac
}

# Whether release $1 is newer than release $2.
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0)
    exit 1
  }'
}

# Holds an exclusive lock on file $1 through descriptor 9 until it closes. The
# kernel releases it when the process ends, however it ends.
lock() {
  exec 9>>"$1"
  if command -v flock >/dev/null; then
    flock 9
  else # macOS has no flock(1)
    perl -MFcntl=:flock -e 'open(my $lock, ">&=9") or die "$!\n";
      flock($lock, LOCK_EX) or die "$!\n"'
  fi
}

command="$1"
shift
# Buzz keeps its own Codex home, beside the releases, so its conversations stay
# out of the user's Codex history, and the Codex app, which holds a writer lock
# on each recent thread it reopens, can't block them. It links in only the
# settings, sign-in and instructions, and never replaces a file in the way.
if [ "$command" = run ] || [ "$command" = adopt ]; then
  mkdir -p "${CODEX_HOME:-$HOME/.codex}"
  shared=$(cd "${CODEX_HOME:-$HOME/.codex}" && pwd -P)
  mkdir -p -m 700 "$dir-home"
  home=$(cd "$dir-home" && pwd -P)
  # A desktop build launched by a Buzz agent inherits this isolated home.
  # Recover its original shared home from our existing absolute config link,
  # then let the usual checks validate every link before starting Codex.
  if [ "$shared" = "$home" ]; then
    config=$(readlink "$home/config.toml" 2>/dev/null || true)
    case "$config" in
      /*/config.toml) shared=$(cd "${config%/config.toml}" && pwd -P) ;;
    esac
  fi
  [ "$home" != "$shared" ] ||
    { echo "Buzz's Codex home must differ from the shared one" >&2; exit 1; }
  # Codex can't make its skills folder through a link to nothing. Something
  # else in the way is left for Codex to handle, as it would in the shared home.
  mkdir -p "$shared/skills" "$shared/rules" 2>/dev/null || true
  # `codex login` signs out first, removing the link, so signing in from Buzz
  # leaves a file here. The shared sign-in, which that revoked, takes it as it would
  # have through the link, unless the shared one is newer. Under a lock, so runs
  # starting at once hand it over once. An empty file is one Codex is still writing.
  if [ -s "$home/auth.json" ] && [ ! -L "$home/auth.json" ]; then
    lock "$dir-home.lock"
    if [ -s "$home/auth.json" ] && [ ! -L "$home/auth.json" ]; then
      # Through any links the user made, bounded in case they loop.
      auth="$shared/auth.json" hops=0
      while [ -L "$auth" ] && [ $((hops += 1)) -le 40 ]; do
        link=$(readlink "$auth")
        case "$link" in /*) auth=$link ;; *) auth=${auth%/*}/$link ;; esac
      done
      # Replaced whole, so never left partial, and private.
      [ "$shared/auth.json" -nt "$home/auth.json" ] ||
        (umask 077 && cat "$home/auth.json" >"$auth.buzz" && mv -f "$auth.buzz" "$auth") || {
        rm -f "$auth.buzz"
        echo "Buzz couldn't save the Codex sign-in to $shared/auth.json" >&2
        exit 1
      }
      rm -f "$home/auth.json"
    fi
    exec 9>&-
  fi
  for name in config.toml auth.json AGENTS.md rules skills; do
    [ -e "$home/$name" ] || [ -L "$home/$name" ] ||
      ln -sn "$shared/$name" "$home/$name" 2>/dev/null || true
    [ "$(readlink "$home/$name")" = "$shared/$name" ] ||
      { echo "Buzz's Codex setup conflicts with $home/$name" >&2; exit 1; }
  done
  export CODEX_HOME="$home"
fi
case "$command" in
run)
  # Even a shared `sqlite_home` setting must not lead back to the user's history.
  set -- -c "sqlite_home=$home" "$@"
  # A failed exec returns (execfail, without errexit), so the launcher can
  # look again when a release it read was pruned before it started.
  set +e
  shopt -s execfail
  while :; do
    # The plugin names a release to test it before it is in use.
    version="${BUZZ_CODEX_VERSION:-$(cat "$dir/current" 2>/dev/null)}"
    # 127, as for a missing program: the plugin reads it as "not installed".
    valid "$version" || { echo "Codex is not installed" >&2; exit 127; }
    exec "$dir/$version/bin/codex" "$@"
    # Builds that switched after the read above may have pruned its release;
    # then start the one `current` names now.
    [ -z "${BUZZ_CODEX_VERSION:-}" ] &&
      [ "$(cat "$dir/current" 2>/dev/null)" != "$version" ] || exit 127
  done
  ;;
install)
  version="$1" target="$2" checksum="$3"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  case "$target" in
  aarch64-apple-darwin | x86_64-apple-darwin | \
    aarch64-unknown-linux-musl | x86_64-unknown-linux-musl) ;;
  *) echo "Unsupported platform" >&2; exit 2 ;;
  esac
  # Each download unpacks in its own hidden folder, so two Buzz builds
  # updating at once do not write over each other, and a stopped one leaves
  # nothing.
  part="$dir/.install.$$"
  mkdir -p "$part/package"
  trap 'rm -rf "$part"' EXIT
  trap 'exit 143' INT TERM
  # Give up on a stalled download rather than holding the update forever.
  curl -fsSL --speed-limit 1024 --speed-time 60 -o "$part/package.tar.gz" \
    "https://releases.openai.com/codex/releases/$version/codex-package-$target.tar.gz"
  # The release's published checksum, which the plugin passes in.
  actual=$( (shasum -a 256 "$part/package.tar.gz" 2>/dev/null ||
    sha256sum "$part/package.tar.gz") | cut -d" " -f1)
  [ "$actual" = "$checksum" ] || { echo "The download did not match its checksum" >&2; exit 1; }
  tar -xzf "$part/package.tar.gz" -C "$part/package"
  test -x "$part/package/bin/codex"
  # A rename, so a session starting now sees no folder or the whole release.
  # Another build that already installed this release keeps its folder.
  [ -d "$dir/$version" ] || mv "$part/package" "$dir/$version"
  ;;
use)
  version="$1"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  # One switch at a time across Buzz builds, so none prunes the release
  # another just switched to.
  lock "$dir/.lock"
  # Checked under the lock: another build may have pruned it meanwhile.
  test -x "$dir/$version/bin/codex" ||
    { echo "Codex $version is no longer downloaded" >&2; exit 1; }
  previous=$(cat "$dir/current" 2>/dev/null || true)
  printf %s "$version" >"$dir/current.$$"
  mv -f "$dir/current.$$" "$dir/current"
  # Keep the new release, the one before it to fall back to, and any newer
  # one, which another build may be testing; remove the rest.
  for folder in "$dir"/*/; do
    folder=$(basename "$folder")
    [ "$folder" = "$version" ] || [ "$folder" = "$previous" ] ||
      newer "$folder" "$version" || rm -rf "${dir:?}/$folder"
  done
  ;;
adopt)
  # Threads Buzz saved before it had its own home stay in the user's, which
  # keeps them; Buzz continues from a copy. Codex names each rollout with its
  # thread id.
  thread="$1"
  case "$thread" in "" | *[!0-9A-Za-z-]*) echo "Invalid thread" >&2; exit 2 ;; esac
  for rollout in "$shared"/sessions/*/*/*/rollout-*-"$thread".jsonl; do
    [ -f "$rollout" ] || continue
    copy="$home/${rollout#"$shared"/}"
    # Never over a copy Buzz already continued, here or in another build.
    [ -e "$copy" ] && continue
    mkdir -p "$(dirname "$copy")"
    cp -p "$rollout" "$copy.$$"
    # The Codex app may be writing the thread now. A line it has not finished
    # is skipped when read, and must not join the next line Buzz writes.
    [ -z "$(tail -c 1 "$copy.$$")" ] || echo >>"$copy.$$"
    # A hard link publishes the whole copy, and fails if one is already there.
    ln "$copy.$$" "$copy" 2>/dev/null || true
    rm -f "$copy.$$"
  done
  ;;
*)
  echo "Unknown command: $command" >&2
  exit 2
  ;;
esac
