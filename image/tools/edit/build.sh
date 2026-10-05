#!/bin/sh
# Microsoft Edit, as msedit, the name Microsoft asks distributions to give it,
# and as edit beside it. Its search and replace load ICU, which the image has.

set -eu

VERSION=2.0.0
COMMIT=d3f86975dc3c1298bf7300dbdf409a1df8d8b2b7

apk add --no-cache git rust rust-src cargo icu-libs > /dev/null
git -c advice.detachedHead=false clone -q --depth 1 --branch "v$VERSION" https://github.com/microsoft/edit /edit
cd /edit
test "$(git rev-parse HEAD)" = "$COMMIT"

# Search and replace load ICU when first used, by file name; ICU names its
# libraries after its major version, the one Alpine has.
icu=$(basename /usr/lib/libicuuc.so.[0-9]* | head -n1 | cut -d. -f3)

# The release profile rebuilds the standard library to shed size, a nightly
# feature that Alpine's stable Rust allows under RUSTC_BOOTSTRAP.
RUSTC_BOOTSTRAP=1 \
	EDIT_CFG_ICUUC_SONAME="libicuuc.so.$icu" \
	EDIT_CFG_ICUI18N_SONAME="libicui18n.so.$icu" \
	cargo build --release --config .cargo/release.toml

install -D -m 755 target/release/edit "$OUT/usr/bin/msedit"
ln -s msedit "$OUT/usr/bin/edit"
echo "Edit $VERSION, ICU $icu, $(wc -c < target/release/edit) bytes"
