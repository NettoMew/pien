#!/bin/sh
# Builds the guest kernel in a throwaway Alpine container. The config fragment
# arrives on stdin, the kernel leaves on stdout, the log goes to stderr:
#
#   docker run --rm -i -v homepage-kernel:/cache alpine:3.24 sh -c "$(cat build.sh)" \
#     < config > bzImage
#
# The volume keeps the source tree and the build directory between runs, so a
# rebuild only recompiles what the config change touches.

set -eu

VERSION=6.18.55
SHA256=f410638061a165c12f42ab871d2f3fcd525515359b5faeee80969cff84524df9

exec 3>&1 1>&2 # stdout is for the kernel alone

mkdir -p /cache/apk
apk --cache-dir /cache/apk add build-base bc bison flex perl linux-headers elfutils-dev xz > /dev/null
cat > /tmp/fragment

cd /cache
if [ ! -d "linux-$VERSION" ]; then
	echo "kernel: fetching Linux $VERSION"
	wget -q "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$VERSION.tar.xz"
	echo "$SHA256  linux-$VERSION.tar.xz" | sha256sum -c -s
	tar xJf "linux-$VERSION.tar.xz"
	rm "linux-$VERSION.tar.xz"
fi

out=/cache/build-$VERSION
make -C "linux-$VERSION" ARCH=i386 O="$out" KCONFIG_ALLCONFIG=/tmp/fragment allnoconfig > /dev/null

# Kconfig quietly drops what it can't satisfy; refuse to build without it.
failed=0
while IFS= read -r line; do
	case $line in
	CONFIG_*=*) grep -qxF "$line" "$out/.config" || { echo "kernel: $line did not stick"; failed=1; } ;;
	esac
done < /tmp/fragment
[ "$failed" = 0 ]

echo "kernel: building with $(nproc) jobs"
make -C "$out" ARCH=i386 -j"$(nproc)" bzImage > /dev/null
echo "kernel: $(wc -c < "$out/arch/x86/boot/bzImage") bytes"
cat "$out/arch/x86/boot/bzImage" >&3
