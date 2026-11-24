#!/bin/sh
# clec one-line installer for macOS and Linux.
set -eu

REPO="Centurybbx/clec-cli"

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

if [ -n "${CLEC_VERSION:-}" ]; then
    case "$CLEC_VERSION" in
        v*) tag="$CLEC_VERSION" ;;
        *) tag="v$CLEC_VERSION" ;;
    esac
    base="https://github.com/$REPO/releases/download/$tag"
else
    base="https://github.com/$REPO/releases/latest/download"
fi

os=$(uname -s)
arch=$(uname -m)
case "$os" in
    Darwin)
        case "$arch" in
            arm64 | aarch64) target="aarch64-apple-darwin" ;;
            x86_64 | amd64) target="x86_64-apple-darwin" ;;
            *) fail "unsupported macOS architecture: $arch" ;;
        esac
        ;;
    Linux)
        case "$arch" in
            x86_64 | amd64) target="x86_64-unknown-linux-gnu" ;;
            aarch64 | arm64) target="aarch64-unknown-linux-gnu" ;;
            *) fail "unsupported Linux architecture: $arch" ;;
        esac
        ;;
    *)
        fail "unsupported operating system: $os (use install.ps1 on Windows)"
        ;;
esac

download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 --connect-timeout 15 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --timeout=60 -O "$2" "$1"
    else
        fail "curl or wget is required"
    fi
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{ print $1 }'
    else
        fail "sha256sum or shasum is required"
    fi
}

staged=""
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/clec-install.XXXXXX") || fail "could not create a temporary directory"
cleanup() {
    rm -rf "$tmpdir"
    [ -z "$staged" ] || rm -f "$staged"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive="clec-${target}.tar.gz"
say "Downloading $archive ..."
download "$base/$archive" "$tmpdir/$archive"
download "$base/SHA256SUMS.txt" "$tmpdir/SHA256SUMS.txt"

expected=$(awk -v name="$archive" '{
    file = $2
    sub(/^\*/, "", file)
    if (file == name) {
        print $1
        exit
    }
}' "$tmpdir/SHA256SUMS.txt")
[ -n "$expected" ] || fail "no checksum for $archive in SHA256SUMS.txt"

actual=$(sha256_of "$tmpdir/$archive")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive (expected $expected, got $actual)"

install_dir=${CLEC_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$tmpdir/dist" "$install_dir"
tar -xzf "$tmpdir/$archive" -C "$tmpdir/dist"
[ -f "$tmpdir/dist/clec" ] || fail "archive did not contain the clec binary"
staged="$install_dir/.clec.tmp.$$"
cp "$tmpdir/dist/clec" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$install_dir/clec"
staged=""

skill_dir="$HOME/.agents/skills/clec"
mkdir -p "$skill_dir"
download "$base/SKILL.md" "$tmpdir/SKILL.md"
expected_skill=$(awk -v name="SKILL.md" '{
    file = $2
    sub(/^\*/, "", file)
    if (file == name) {
        print $1
        exit
    }
}' "$tmpdir/SHA256SUMS.txt")
[ -n "$expected_skill" ] || fail "no checksum for SKILL.md in SHA256SUMS.txt"
actual_skill=$(sha256_of "$tmpdir/SKILL.md")
[ "$expected_skill" = "$actual_skill" ] || fail "checksum mismatch for SKILL.md (expected $expected_skill, got $actual_skill)"
staged="$skill_dir/.SKILL.md.tmp.$$"
cp "$tmpdir/SKILL.md" "$staged"
mv -f "$staged" "$skill_dir/SKILL.md"
staged=""

if [ "${CLEC_SKIP_SYNC:-0}" != "1" ]; then
    say "Downloading the latest index ..."
    if ! "$install_dir/clec" sync; then
        printf 'warning: clec sync failed; run %s sync later to install the index\n' "$install_dir/clec" >&2
    fi
fi

say "Installed clec to $install_dir/clec"
say "Installed agent skill to $skill_dir/SKILL.md"
say "Verify with: $install_dir/clec stats"
case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) say "Add $install_dir to PATH, or use the absolute path: $install_dir/clec" ;;
esac
