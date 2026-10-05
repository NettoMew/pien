# 工作台（`workbench`）

> **已封存（2026-10-05）。** 代码都还在，但工具链盘不再构建，也不随站点部署，页面不会启动它，客户机里也没有 `workbench` 和 `home` 两个命令。adb、fastboot、串口、拖进文件都在 home 上，不受影响。
>
> 解封：
> 1. `vm.config.ts` 里把 workbench 的 `sealed` 改回 `false`；
> 2. 把 `image/workbench/functions/` 里的三个文件移回 `image/rootfs/etc/fish/functions/`，`help.fish` 里加回工作台的几行（封存前的版本：`git show 50c10d8:image/rootfs/etc/fish/functions/help.fish`）；
> 3. `package.json` 的 `build:vm` 加回 `npm run build:workbench`，CI 加回构建和 `check:usb -- workbench`；
> 4. 重新构建、部署，站点会重新带上约 740 MB 的盘。

敲 `workbench`，屏幕关掉，换一台大机器开起来：768 MB 可用内存，外加一块装着工具链的盘。`home` 换回来。地址里带 `?workbench` 时直接开工作台。

```
guest@zutto-issho ~> workbench
  Powering down for the workbench: 768 MB
  and a disk of toolchains — gcc, clang,
  rust, go, node and nvim. `home` comes
  back here.
```

两台机器用的是同一个镜像、同一个内核，区别只在内存大小和那块盘（`vm.config.ts` 的 `machines`）。

## 盘上有什么

完整清单在 `image/image.config.ts` 的 `workbench` 里。

| | |
|---|---|
| C、C++ | gcc 15.2、clang 22.1（lld、lldb、clangd、clang-format）、cmake、meson、samurai、gdb、valgrind、strace、ltrace |
| Rust | rustc 1.96、cargo、rust-src、rust-analyzer、rustfmt、clippy |
| Go | go 1.26（标准库已经编译好）、gopls、delve、golangci-lint、goimports、gofumpt |
| Python | python 3.14、pip、ruff、pyright、debugpy |
| JavaScript | node 24、npm、vtsls、vscode-langservers-extracted、yaml-language-server、bash-language-server、prettier、markdownlint-cli2 |
| 编辑器 | Neovim 0.12 + LazyVim：41 个插件、38 个 tree-sitter 解析器，上面每种语言的 LSP、格式化和调试（gdb、debugpy）都配好了 |
| Android | android-tools 35 的其余工具：mkbootimg、avbtool、img2simg、lpmake 等。adb 和 fastboot 两台机器上都有，见 [docs/usb.md](usb.md) |
| 其他 | git、tig、lazygit、ripgrep、fd、fzf、tmux、bash、jq、yq、sqlite、zip、zstd、openssl |

## 怎么做的

**构建**（`npm run build:workbench`，`image/workbench/Dockerfile`）。在 i686 的 Alpine 容器里装，和客户机是同一套用户空间：

1. `base` 阶段装镜像自己的包，版本精确到镜像构建时的那一个（`manifest.packages`），记下所有文件；
2. `tools` 阶段装工具：apk 的包，npm、go、pip 各自固定版本的几样，再编译 Go 标准库，装好 Neovim 的插件和解析器；
3. 两者之差，也就是新出现的文件，加上版本变了的包的全部文件（去掉 apk 自己的记录、临时目录和手册），按原路径打成 squashfs（zstd 19，256 KB 块）。

本机没有 Docker 时，`BUILD_HOST=<Linux 主机>` 让它经 ssh 在那边构建，连接断了会重试，Docker 的层缓存接着用。产物按输入的内容哈希缓存在 `.cache/workbench/`。

**挂载**。盘是 v86 的 IDE 硬盘（Intel PIIX3，内核里是 `ata_piix`），只能接在主盘位置（`hda`）。页面按 256 KB 的块经 HTTP Range 读，用到哪块才下载哪块。`/etc/rc` 把盘挂在 `/run/toolchain`，再用 overlayfs 把盘上的每个顶层目录（现在是 `/bin`、`/etc`、`/usr`）叠在 9p 上的同名目录上面，写入的东西留在内存里。工具装在它们被装进的那个系统上，路径一个不差。

**快照**。v86 只存用到的内存页：784 MB 的机器存下来 31 MB，压缩后 7.7 MB。

**Neovim**。`/usr/share/nvim/sysinit.vim` 总会被读到；用户没有自己的配置时，它载入 `/usr/share/nvim/workbench/` 里的 LazyVim。插件的提交固定在 `image/workbench/nvim/lazy-lock.json`（第一次构建时写下，之后按它恢复）。Mason 关掉了：语言服务器、格式化工具都在盘上，来自 apk、npm、go 和 pip。配色是 tokyonight 的 night，背景透明，透出显像管。复制经 OSC 52 到访客自己的剪贴板；终端从不把剪贴板交回来，所以粘贴用的是在这里复制的东西，外面的文字用终端的粘贴（Ctrl+Shift+V）。插件和解析器的目录属于访客，`:Lazy update`、`:TSInstall` 都能用，新东西留在内存里。

**Go**。`GOCACHE` 在 `GOROOT` 旁边（`go.env`），构建时编好了标准库。缓存属于访客，里面的条目日期都设在 2100 年：Go 每用一次缓存条目就会把它的修改时间刷新到现在，在 overlay 上这意味着把整个文件复制进内存；日期在未来的条目既不会被刷新，也不会因为"太久没用"被清理掉。

**实测**（Node 里的 v86，同一台机器）：

| | |
|---|---|
| 盘 | squashfs 739 MB，按需读取 |
| `gcc hello.c` | 6 秒 |
| `g++ hello.cc` | 16 秒 |
| `clang hello.c` | 16 秒 |
| `rustc hello.rs` | 12 秒 |
| `go run hello.go` | 第一次 13 秒，之后 2 秒 |
| `python3 -c …`、`node -e …` | 1 秒、4 秒 |
| `nvim` 载入全部插件 | 3 秒 |

## 手机：adb 和 fastboot

手机和别的 USB 设备一样，经 USB/IP 交给客户机，两台机器上都有，见 [docs/usb.md](usb.md)。

## 拖进文件

两台机器上都一样，见 [docs/files.md](files.md)。

