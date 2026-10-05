#!/bin/sh
# Builds Microsoft Edit for the guest in a throwaway i686 Alpine container:
# the guest's own userland, so it links against the musl and libgcc the image
# has. The binary leaves on stdout, the log goes to stderr:
#
#   docker run --rm -i --platform linux/386 alpine:3.24 sh -c "$(cat build.sh)" > msedit

set -eu

VERSION=2.0.0
COMMIT=d3f86975dc3c1298bf7300dbdf409a1df8d8b2b7

exec 3>&1 1>&2 # stdout is for the binary alone

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

echo "msedit: Edit $VERSION, ICU $icu, $(wc -c < target/release/edit) bytes"
cat target/release/edit >&3
