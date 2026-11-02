#!/usr/bin/env bash
# Publishes an immutable desktop-v* release tag. Runs only
# from .github/workflows/desktop-release-tag.yml with the release App token.
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

[[ "$#" -eq 2 ]] || fail "usage: $0 X.Y.Z[-beta.N] COMMIT_SHA"
version="$1"
target_sha="$2"
repo="${GITHUB_REPOSITORY:-}"

[[ "$repo" == "block/buzz-app" ]] || fail "release tags are restricted to block/buzz-app"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-beta\.[1-9][0-9]*)?$ ]] || \
  fail "'$version' is not a release version (expected X.Y.Z or X.Y.Z-beta.N)"
[[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || fail "'$target_sha' is not a full commit SHA"
command -v gh >/dev/null 2>&1 || fail "gh is required"

# Refuse to publish unless an active ruleset protects desktop-v* tags and this App
# can bypass it. GitHub hides bypass_actors from non-admins, so an admin must
# confirm separately that the App is the ruleset's only bypass actor.
rulesets="$(gh api "repos/$repo/rulesets" --jq '.[] | select(.target == "tag" and .enforcement == "active") | .id')" || \
  fail "could not list tag rulesets"
protected=false
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  ruleset="$(gh api "repos/$repo/rulesets/$id")" || fail "could not read tag ruleset $id"
  if jq -e '
      (.conditions.ref_name.include | index("refs/tags/desktop-v*")) != null
      and (.conditions.ref_name.exclude | length) == 0
      and ([.rules[].type] | sort) == ["creation", "deletion", "non_fast_forward", "update"]
      and .current_user_can_bypass == "always"
    ' <<< "$ruleset" >/dev/null; then
    protected=true
  fi
done <<< "$rulesets"
[[ "$protected" == true ]] || \
  fail "no active tag ruleset restricts creation, update and deletion of refs/tags/desktop-v* to this App"

main_sha="$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)" || fail "could not resolve main"
commit_sha="$(gh api "repos/$repo/commits/$target_sha" --jq .sha)" || fail "$target_sha is not a commit in $repo"
[[ "$commit_sha" == "$target_sha" ]] || fail "GitHub resolved requested commit $target_sha as $commit_sha"
merge_base="$(gh api "repos/$repo/compare/$target_sha...$main_sha" --jq .merge_base_commit.sha)" || \
  fail "could not verify that $target_sha is on main"
[[ "$merge_base" == "$target_sha" ]] || fail "$target_sha is not in main history at $main_sha"

tag="desktop-v$version"
tag_object_sha="$(
  gh api --method POST "repos/$repo/git/tags" \
    -f tag="$tag" \
    -f message="Buzz desktop $version" \
    -f object="$target_sha" \
    -f type=commit \
    --jq .sha
)" || fail "could not create annotated tag object for $tag"
[[ "$tag_object_sha" =~ ^[0-9a-f]{40}$ ]] || fail "GitHub returned an invalid tag object SHA"

# Ref creation fails when the tag already exists; published tags are never reused.
gh api --method POST "repos/$repo/git/refs" \
  -f ref="refs/tags/$tag" \
  -f sha="$tag_object_sha" \
  --silent || fail "could not publish $tag (it may already exist)"

published="$(gh api "repos/$repo/git/ref/tags/$tag" --jq '"\(.object.type) \(.object.sha)"')" || \
  fail "could not verify published tag $tag"
[[ "$published" == "tag $tag_object_sha" ]] || fail "$tag does not reference the expected annotated tag object"
pointed="$(gh api "repos/$repo/git/tags/$tag_object_sha" --jq '"\(.object.type) \(.object.sha)"')" || \
  fail "could not verify annotated tag object $tag_object_sha"
[[ "$pointed" == "commit $target_sha" ]] || fail "$tag does not point directly to requested commit $target_sha"

printf 'Published %s at %s through the release App.\n' "$tag" "$target_sha"
