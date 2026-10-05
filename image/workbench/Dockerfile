# Sealed since 2026-10-05, with the workbench (vm.config.ts, docs/workbench.md).
#
# The workbench's toolchain disk (docs/workbench.md), built in the guest's own
# userland — Alpine for i686 — by scripts/build-workbench.ts, which takes home
# the squashfs the last stage holds.
#
# The disk holds what the tools stage changed, at the paths it changed them,
# measured against the base stage: the image's packages at the image's
# versions. /etc/rc lays each of its top-level directories over the guest's,
# so the tools land on exactly the system they were installed on.

FROM alpine:3.24 AS base
ARG BASE
RUN apk add --no-cache $BASE
RUN find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -print | sort > /base.files \
 && apk info -v 2> /dev/null | sort > /base.packages

FROM base AS tools
ARG TOOLS
RUN apk add --no-cache $TOOLS

# Language servers, formatters and a debugger that apk does not carry, pinned.
ARG NPM
RUN npm install --global --no-fund --no-audit --no-update-notifier $NPM \
 && npm cache clean --force
ARG GO
RUN for module in $GO; do GOBIN=/usr/local/bin GOFLAGS=-trimpath go install "$module"; done \
 && go clean -cache -modcache
ARG PIP
RUN pip install --break-system-packages --no-cache-dir --root-user-action=ignore $PIP

# Go's standard library, compiled here once rather than in every first build,
# into a cache beside GOROOT that is the guest's (uid 1000) to add to. Its
# entries are dated far ahead: Go then neither re-dates them on every use,
# which would copy each one up into memory, nor trims them as stale.
RUN echo GOCACHE=/usr/lib/go/cache >> "$(go env GOROOT)/go.env" \
 && go build std \
 && find /usr/lib/go/cache -type f -exec touch -d '2100-01-01 00:00:00' {} + \
 && chown -R 1000:1000 /usr/lib/go/cache

# Neovim: LazyVim with every plugin and parser in place ahead of time, for
# anyone without a configuration of their own (sysinit.vim). The plugins come
# at the lockfile's commits, or on the first build at their latest; the
# parsers are compiled afterwards in a clean Neovim, with nothing else
# installing anything meanwhile: g:workbench_build keeps LazyVim from
# starting on them itself. They are compiled with clang: GCC's
# -Wuninitialized, which tree-sitter's -Wall brings in, takes a 32-bit cc1
# through all 4 GB of its address space on the largest generated parsers
# (gitcommit's parser.c is 3.3 MB), where clang needs 550 MB. The directory
# is the guest's: plugins and parsers it adds or updates land in memory.
COPY build/plugins.lua build/parsers.lua /build/
COPY nvim /usr/share/nvim/workbench
COPY sysinit.vim /usr/share/nvim/sysinit.vim
RUN export CC=clang \
 && cd /usr/share/nvim/workbench \
 && if [ -f lazy-lock.json ]; then verb=restore; else verb=sync; fi \
 && nvim --headless --cmd "let g:workbench_build = 1" "+Lazy! $verb" +qa \
 && nvim --headless --cmd "let g:workbench_build = 1" -c "luafile /build/plugins.lua" -c qa \
 && nvim --headless --clean -l /build/parsers.lua \
 && rm -rf /root/.cache/nvim /root/.local/state/nvim /root/.local/share/nvim \
 && chown -R 1000:1000 /usr/share/nvim/workbench

# The shell's side: what fish adds on the workbench.
COPY fish /usr/share/fish/

COPY build/changed.sh /build/
RUN sh /build/changed.sh

FROM tools AS disk
RUN apk add --no-cache squashfs-tools tar > /dev/null \
 && mkdir /stage \
 && tar -C / --no-recursion -cf - -T /build/disk.files | tar -C /stage -xf - \
 && mksquashfs /stage /workbench.sqfs -comp zstd -Xcompression-level 19 -b 256K -noappend -quiet -no-progress \
 && echo "disk: $(wc -l < /build/disk.files) paths, $(du -sh /stage | cut -f1) raw, $(du -h /workbench.sqfs | cut -f1) squashfs" >&2

FROM alpine:3.24
COPY --from=disk /workbench.sqfs /usr/share/nvim/workbench/lazy-lock.json /
