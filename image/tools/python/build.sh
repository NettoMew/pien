#!/bin/sh
# The Python layer: tools that live on PyPI or GitHub rather than in Alpine,
# installed over Alpine's Python. Those on PyPI are pinned by version and
# hash in requirements.txt, those on GitHub alone by commit in sources; each
# is taken without its dependencies, which are Alpine's own packages
# (image.config.ts). Their byte code is compiled here, once: in the guest,
# the visitor cannot write it where the modules are.

set -eu

apk add --no-cache python3 py3-pip py3-setuptools py3-hatchling git > /dev/null
install() {
	python3 -m pip install --quiet --root "$OUT" --prefix /usr --no-deps --no-build-isolation --no-compile \
		--break-system-packages --root-user-action ignore --disable-pip-version-check "$@"
}

install --requirement requirements.txt --require-hashes

grep -v '^#' sources | while read -r name repository commit; do
	[ -n "$name" ] || continue
	git init -q "/src/$name"
	git -C "/src/$name" fetch -q --depth 1 "$repository" "$commit"
	git -C "/src/$name" -c advice.detachedHead=false checkout -q FETCH_HEAD
	install "/src/$name"
done

# Commands that would only fail here: rich-click's own, which came for
# esptool; mtkclient's window, with no screen to show it; and edl's tools
# that speak telnet through Exscript, which nothing packages.
cd "$OUT/usr/bin"
rm rich-click mtk_gui boottodwnload enableadb sierrakeygen

# Byte code that never asks whether its source changed: in the image, none does.
python3 -m compileall -q -j 0 --invalidation-mode unchecked-hash -s "$OUT" -p / "$OUT/usr/lib"
echo "$(python3 --version): $(ls "$OUT/usr/bin" | tr '\n' ' ')"
