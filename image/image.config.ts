// What goes into the guest's userland. image/rootfs/ is laid over it verbatim;
// the kernel is built separately, from image/kernel/.

export default {
  mirror: "https://dl-cdn.alpinelinux.org/alpine",
  branch: "v3.24",
  arch: "x86",
  repos: ["main", "community"],

  packages: ["busybox", "busybox-binsh", "fish", "fastfetch", "htop", "tree", "curl"],

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

  modes: { "/etc/shadow": 0o600 } as Record<string, number>,

  user: { uid: 1000, gid: 1000, home: "/home/guest" },
  hostname: "home",
};
