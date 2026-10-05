#!/bin/sh
# picotool: Raspberry Pi's RP2040 and RP2350, in BOOTSEL or running. Alpine
# has none. It builds against the Pico SDK's headers, of the same release.

set -eu

VERSION=2.3.1
PICOTOOL=2041936441b48a3cc53ae3da9e805229fe8f4e18
SDK=079c6f39023649b154152db30f1d781e884879bc

apk add --no-cache build-base cmake samurai git libusb-dev linux-headers > /dev/null
fetch() { # <directory> <repository> <commit>
	git init -q "$1"
	git -C "$1" fetch -q --depth 1 "$2" "$3"
	git -C "$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
}
fetch /picotool https://github.com/raspberrypi/picotool "$PICOTOOL"
# The libraries it builds in, and the SDK's mbedtls for signing and hashing,
# are submodules, pinned by the commits above.
git -C /picotool submodule -q update --init --depth 1
fetch /pico-sdk https://github.com/raspberrypi/pico-sdk "$SDK"
git -C /pico-sdk submodule -q update --init --depth 1 lib/mbedtls

cmake -S /picotool -B /build -G Ninja -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_INSTALL_PREFIX=/usr \
	-DPICO_SDK_PATH=/pico-sdk > /dev/null
cmake --build /build > /dev/null
DESTDIR="$OUT" cmake --install /build --strip > /dev/null
# The rest is for a desktop's udev, and for other builds to find picotool by.
find "$OUT" -name '*.rules' -delete
rm -rf "$OUT/usr/lib/cmake"
echo "picotool $VERSION: $(find "$OUT" -type f | tr '\n' ' ')"
