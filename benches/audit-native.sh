#!/bin/sh
# Build into a new target directory and transparently log native compilation on macOS.
set -eu
root=${1:-/tmp/clec-stage0-bench}
mkdir -p "$root"
audit=$(mktemp -d "$root/audit.XXXXXX")
manifest=$(cd "$(dirname "$0")/.." && pwd)/Cargo.toml
export STAGE0_NATIVE_LOG="$audit/native-sources.tsv"
export CARGO_TARGET_DIR="$audit/target"

cat > "$audit/compiler" <<'WRAPPER'
#!/bin/sh
for arg do
    case "$arg" in
        *.c|*.cc|*.cpp|*.cxx|*.s|*.S)
            printf '%s\t%s\n' "$PWD" "$arg" >> "$STAGE0_NATIVE_LOG"
            ;;
    esac
done
exec /usr/bin/clang "$@"
WRAPPER
chmod +x "$audit/compiler"
printf '%s\n' "$audit"
CC="$audit/compiler" CXX="$audit/compiler" cargo build --release --manifest-path "$manifest" \
    > "$audit/build.log" 2>&1
cargo tree --locked -e features --manifest-path "$manifest" > "$audit/cargo-tree-features.txt"
cargo tree --locked -e normal,build -i zstd-sys --manifest-path "$manifest" \
    > "$audit/zstd-dependents.txt"
otool -L "$CARGO_TARGET_DIR/release/clec" > "$audit/dylibs.txt"
stat -f '%z' "$CARGO_TARGET_DIR/release/clec" > "$audit/binary-bytes.txt"
