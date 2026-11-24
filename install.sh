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

staged_bin=""
staged_skill=""
backup_skill=""
lock_dir=""
committed=0
skill_replaced=0
skill_existed=0
skill_dir=""
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/clec-install.XXXXXX") || fail "could not create a temporary directory"
cleanup() {
    if [ "$committed" != "1" ] && [ -n "$staged_bin" ] && [ ! -e "$staged_bin" ]; then
        committed=1
    fi
    rm -rf "$tmpdir"
    [ -z "$staged_bin" ] || rm -f "$staged_bin"
    [ -z "$staged_skill" ] || rm -f "$staged_skill"
    if [ "$committed" != "1" ] && [ "$skill_replaced" = "1" ]; then
        if [ "$skill_existed" = "1" ] && [ -n "$backup_skill" ]; then
            mv -f "$backup_skill" "$skill_dir/SKILL.md" 2>/dev/null || true
            backup_skill=""
        elif [ "$skill_existed" = "0" ]; then
            rm -f "$skill_dir/SKILL.md"
        fi
    fi
    if [ "$committed" = "1" ] && [ -n "$backup_skill" ]; then
        rm -f "$backup_skill"
    fi
    [ -z "$lock_dir" ] || rm -rf "$lock_dir"
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
skill_dir="$HOME/.agents/skills/clec"
mkdir -p "$tmpdir/dist" "$install_dir" "$skill_dir"

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

tar -xzf "$tmpdir/$archive" -C "$tmpdir/dist"
[ -f "$tmpdir/dist/clec" ] || fail "archive did not contain the clec binary"
staged_bin="$install_dir/.clec.tmp.$$"
cp "$tmpdir/dist/clec" "$staged_bin"
chmod 755 "$staged_bin"
staged_skill="$skill_dir/.SKILL.md.tmp.$$"
cp "$tmpdir/SKILL.md" "$staged_skill"

lock_candidate="$skill_dir/.clec-lock"
if mkdir "$lock_candidate" 2>/dev/null; then
    lock_dir="$lock_candidate"
else
    other=$(cat "$lock_candidate/pid" 2>/dev/null || true)
    if [ -z "$other" ]; then
        fail "install lock exists without a pid; remove $lock_candidate if stale"
    fi
    if kill -0 "$other" 2>/dev/null; then
        fail "another clec install is running (pid $other)"
    fi
    rm -rf "$lock_candidate"
    mkdir "$lock_candidate" || fail "could not acquire $lock_candidate"
    lock_dir="$lock_candidate"
fi
printf '%s\n' "$$" > "$lock_dir/pid"

if [ -e "$skill_dir/SKILL.md" ] || [ -L "$skill_dir/SKILL.md" ]; then
    skill_existed=1
    old_skill="$skill_dir/.SKILL.md.old.$$"
    cp -pP "$skill_dir/SKILL.md" "$old_skill"
    backup_skill="$old_skill"
fi

skill_replaced=1
mv -f "$staged_skill" "$skill_dir/SKILL.md"
staged_skill=""

mv -f "$staged_bin" "$install_dir/clec"
committed=1
staged_bin=""
if [ -n "$backup_skill" ]; then
    rm -f "$backup_skill"
    backup_skill=""
fi
if [ -n "$lock_dir" ]; then
    rm -rf "$lock_dir"
    lock_dir=""
fi

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
