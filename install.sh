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

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/clec-install.XXXXXX") || fail "could not create a temporary directory"
cleanup() {
    rm -rf "$tmpdir"
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

if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmpdir/$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmpdir/$archive" | awk '{ print $1 }')
else
    fail "sha256sum or shasum is required"
fi

[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive (expected $expected, got $actual)"

install_dir=${CLEC_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$tmpdir/dist" "$install_dir"
tar -xzf "$tmpdir/$archive" -C "$tmpdir/dist"
[ -f "$tmpdir/dist/clec" ] || fail "archive did not contain the clec binary"
cp "$tmpdir/dist/clec" "$install_dir/clec"
chmod 755 "$install_dir/clec"

skill_dir="$HOME/.agents/skills/clec"
mkdir -p "$skill_dir"
if ! download "$base/SKILL.md" "$skill_dir/SKILL.md" 2>/dev/null; then
    download "https://raw.githubusercontent.com/$REPO/main/skills/clec/SKILL.md" "$skill_dir/SKILL.md"
fi

if [ "${CLEC_SKIP_SYNC:-0}" != "1" ]; then
    say "Downloading the latest index ..."
    if ! "$install_dir/clec" sync; then
        printf 'warning: clec sync failed; run %s sync later to install the index\n' "$install_dir/clec" >&2
    fi
fi

say "Installed clec to $install_dir/clec"
say "Installed agent skill to $skill_dir/SKILL.md"
case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) say "Add $install_dir to PATH, for example: export PATH=\"$install_dir:\$PATH\"" ;;
esac
