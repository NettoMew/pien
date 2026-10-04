#!/bin/sh
# Writes to /build/disk.files, one per line, the paths the tools stage added
# or changed (see Dockerfile): everything new, and every file of a package
# that is not the base's at the base's version — an upgraded library replaces
# its old self. Left out: apk's own records, what is only ever transient, the
# build's scratch, and manuals, which the image goes without too.

set -eu

find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -print | sort > /build/tools.files

{
	comm -13 /base.files /build/tools.files
	apk info -v 2> /dev/null | sort | comm -13 /base.packages - \
		| sed -E 's/-[^-]+-r[0-9]+$//' \
		| xargs -r apk info -qL 2> /dev/null \
		| sed -n 's|^.|/&|p'
} | sort -u | grep -v -E \
	-e '^/(etc/apk|lib/apk|var/cache|var/log|run|tmp|root|home)(/|$)' \
	-e '^/(base\.files|base\.packages|build)(/|$)' \
	-e '^/usr/share/(man|doc|info)/' > /build/disk.files

echo "laid over: $(cut -d/ -f2 /build/disk.files | sort -u | sed 's|^|/|' | tr '\n' ' ')" >&2
