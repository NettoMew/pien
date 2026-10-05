#!/bin/sh
# lrzsz: XMODEM, YMODEM and ZMODEM over a serial line, for U-Boot's loadx and
# loady and the like. sz, sx and sb send; rz, rx and rb receive. Alpine has
# none; 0.13 is the first release in decades, and fixes old overflows in
# both directions.

set -eu

VERSION=0.13.1
COMMIT=e97e41a6bc0e86b47b2bfb6b3b5db2d3fc1907b6

apk add --no-cache build-base autoconf automake gettext-dev git > /dev/null
git init -q /lrzsz
cd /lrzsz
git fetch -q --depth 1 https://github.com/UweOhse/lrzsz "$COMMIT"
git -c advice.detachedHead=false checkout -q FETCH_HEAD

# The repository keeps the sources of configure, not configure itself.
autoreconf -fi > /dev/null 2>&1
# Warnings stop the build by default, a developer's setting; configure lets a
# release build turn it off. (A printf format that is wrong on 32 bits is one.)
./configure --prefix=/usr --disable-nls --disable-Werror --program-transform-name='s/^l//' > /dev/null
make -s
make -s install-strip DESTDIR="$OUT"
rm -rf "$OUT/usr/share"
echo "lrzsz $VERSION: $(ls "$OUT/usr/bin" | tr '\n' ' ')"
