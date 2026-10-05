#!/bin/sh
# The Python layer: tools that live on PyPI rather than in Alpine, installed
# over Alpine's Python. Each is pinned by version and hash in
# requirements.txt and taken without its dependencies, which are Alpine's
# own packages (image.config.ts). Their byte code is compiled here, once:
# in the guest, the visitor cannot write it where the modules are.

set -eu

apk add --no-cache python3 py3-pip py3-setuptools > /dev/null
python3 -m pip install --quiet --root "$OUT" --prefix /usr --requirement requirements.txt --require-hashes --no-deps \
	--no-build-isolation --no-compile --break-system-packages --root-user-action ignore --disable-pip-version-check

# rich-click comes for esptool, not for its own command.
rm "$OUT/usr/bin/rich-click"

# Byte code that never asks whether its source changed: in the image, none does.
python3 -m compileall -q -j 0 --invalidation-mode unchecked-hash -s "$OUT" -p / "$OUT/usr/lib"
echo "$(python3 --version): $(ls "$OUT/usr/bin" | tr '\n' ' ')"
