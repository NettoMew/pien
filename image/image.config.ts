// What goes into the guest's userland. image/rootfs/ is laid over it verbatim;
// the kernel is built separately, from image/kernel/.

export default {
  mirror: "https://dl-cdn.alpinelinux.org/alpine",
  branch: "v3.24",
  arch: "x86",
  repos: ["main", "community"],

  packages: [
    "busybox", "busybox-binsh", "fish", "fastfetch", "htop", "tree", "curl", "ssl_client", "openssh-client-default", "mtr", "tzdata",
    // A phone on the visitor's USB (src/usb/), on either machine. Alpine's adb
    // and fastboot bring python3 along.
    "android-tools-adb", "android-tools-fastboot", "socat",
    // A serial port from the visitor's computer (src/serial/), and a terminal for it.
    "tio",
  ],

  // fish wants the full terminfo database; the common entries are plenty.
  replace: { "ncurses-terminfo": "ncurses-terminfo-base" },

  exclude: [
    "/etc/logrotate.d",
    "/etc/network",
    "/etc/udhcpc",
    "/usr/share/applications",
    "/usr/share/doc",
    "/usr/share/fish/man",
    "/usr/share/fish/tools",
    "/usr/share/icons",
    "/usr/share/man",
    "/usr/share/pixmaps",
    "/usr/share/udhcpc",
  ],

  // mtr-packet opens raw sockets: setuid, as on any distribution without file capabilities.
  modes: { "/etc/shadow": 0o600, "/usr/sbin/mtr-packet": 0o4755 } as Record<string, number>,

  user: { uid: 1000, gid: 1000, home: "/home/guest" },
  hostname: "zutto-issho",

  // The workbench's second disk (docs/workbench.md): compilers, runtimes,
  // language servers and a configured Neovim, built by
  // scripts/build-workbench.ts and laid over the guest's own directories.
  // What apk cannot provide comes from each language's own installer, pinned.
  workbench: {
    packages: [
      // C and C++
      "build-base", "clang", "clang-extra-tools", "lld", "lldb", "cmake", "samurai", "meson", "pkgconf", "gdb", "valgrind", "strace", "ltrace",
      // Rust
      "rust", "cargo", "rust-src", "rust-analyzer", "rustfmt", "rust-clippy",
      // Go
      "go", "gopls", "delve", "golangci-lint",
      // Python
      "python3", "python3-dev", "py3-pip", "ruff",
      // JavaScript
      "nodejs", "npm",
      // The editor, and what a day of programming reaches for
      "neovim", "tree-sitter-cli", "lua-language-server", "stylua", "shfmt", "taplo",
      "git", "tig", "lazygit", "ripgrep", "fd", "fzf", "tmux", "bash", "less", "file", "jq", "yq-go", "sqlite",
      "zip", "unzip", "xz", "zstd", "tar", "openssl",
      // The rest of Android's tools: images, partitions, boot images
      "android-tools",
    ],
    npm: [
      "pyright@1.1.414",
      "@vtsls/language-server@0.3.0",
      "vscode-langservers-extracted@4.10.0",
      "yaml-language-server@1.24.0",
      "bash-language-server@5.8.1",
      "prettier@3.9.9",
      "markdownlint-cli2@0.23.3",
    ],
    go: ["golang.org/x/tools/cmd/goimports@v0.51.0", "mvdan.cc/gofumpt@v0.12.0"],
    pip: ["debugpy==1.8.22"],
  },
};
