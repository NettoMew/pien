# guest@zutto-issho

一台运行在浏览器里的、真正的 Linux，当作个人主页。Alpine 3.24 用户空间，自己编译的 6.18 内核，fish 4.6，跑在 [v86](https://github.com/copy/v86) 里。

```sh
npm install
npm run build:warp     # 用 Rust 编 WARP 客户端（wasm）；先 rustup target add wasm32-unknown-unknown
npm run build:kernel   # 在 Docker 里编译内核；本机没有 Docker 时：BUILD_HOST=<Linux 主机> npm run build:kernel
npm run build:vm       # 构建镜像和工作台的工具链盘（也用 Docker），再在 Node 里开两台机器、各存一份快照
npm run dev            # http://localhost:5173
```

| 命令 | 作用 |
|---|---|
| `npm run shell` | 从本地终端连进这台机器（Ctrl-] 退出） |
| `npm run shell -- -c "uname -a"` | 跑一条命令；加 `--trace` 看客户机通过 9p 读了哪些文件，加 `--machine workbench` 连进工作台 |
| `npm run shell -- --put 本地路径=/mnt/x -c "..."` | 先把本地文件放进客户机再跑，改脚本不用重建镜像（Git Bash 下要设 `MSYS_NO_PATHCONV=1`） |
| `npm run smoke [url]` | 用本机 Chrome 端到端测一遍，截图在 `.cache/smoke/` |
| `npm run check:usb` | 给工作台插一台假手机，让客户机里真正的 adb 和 fastboot 经页面的桥对它走一遍（见 [docs/workbench.md](docs/workbench.md)） |
| `npm run lint` / `npm run typecheck` / `npm run build` | oxlint / 类型检查 / 先类型检查再生产构建，产物在 `dist/` |
| `cargo test --manifest-path relay/Cargo.toml` | 中继的测试：一台 smoltcp 访客经真实的 WebSocket 连进中继 |
| `RELAY=host:port npm run dev` | 开发服务器把 `/relay` 转给那里的中继（默认 127.0.0.1:8095，见 docs/relay.md） |
| `npm run warp -- register` / `delete` | 注册或删除一个开发用的 WARP 设备，配合 `warp/examples/edge.rs` 直连入口（见 [docs/warp.md](docs/warp.md)） |
| `WARP_EDGE=host:port npm run dev` | 本机连不上 WARP 入口时，让开发服务器走别的路径，比如一条 SSH 转发 |

页面加 `?cold` 会冷启动内核，而不是恢复快照（调试用）；加 `?workbench` 直接开工作台。

## 怎么工作的

**内核**（`image/kernel/`）。在 `allnoconfig` 上只开 v86 需要的东西：两个串口、virtio 控制台、经 virtio 走的 9p，再加上工作台那块盘要的 IDE（`ata_piix`）、squashfs 和 overlayfs。全部编进内核，内核自己把浏览器提供的 9p 目录挂成根文件系统，不需要模块，也不需要 initramfs。编译在一次性的 Alpine 容器里进行，版本和源码校验和都固定。

**镜像**（`scripts/build-image.ts`）。只用 Node：读 Alpine x86 仓库的索引，解出依赖，解包，叠上 `image/rootfs/` 和 `content/`，输出：

- 一份目录树，只有元数据；
- 每个文件一个块，按内容哈希命名，客户机第一次读到时才下载。

客户机里的 fish 是原装的：提示符、配色、补全都没改，只关掉了欢迎语。自带的脚本和 `md.awk` 也只按名字用颜色（`cyan`、`brblack`……），每种颜色长什么样，由终端的调色板（`src/theme.ts`）决定。主机名在 `image/image.config.ts`，`/etc/hostname`、`/etc/hosts` 和页面标题都从它来。

**快照**（`scripts/build-state.ts`）。在 Node 里冷启动一次，先用一个一次性的会话把常用的东西预热进页缓存，再开一个全新会话、从第一个字节起录下终端输出。等它停在提示符时，整机存成快照，录下的输出另存。访客恢复快照后，页面回放这段输出，fish 已经在提示符等着了。

**页面**（`src/`）。从 Vite 官方模板（React + TypeScript）起步，样式用 Tailwind。机器和终端都在 React 之外，一页只有一份：`session.ts` 在页面一打开时就开始加载 v86，`terminal.ts` 持有 xterm.js，两者之间的状态（加载进度、标题）放在一个 zustand store 里。React 只画屏幕：CRT 的显像管和玻璃（`components/Screen.tsx`），开机动画（`Boot.tsx`，motion：亮点、扫描线、画面过亮地展开，再列出机器的情况，进度条跟着真实的下载走；画面展开时机器已经就绪，就直接到提示符），触屏设备上屏幕下方的一排快捷键（`Keys.tsx`，Lucide 图标）。终端用 DOM 渲染器，每个字符都是一个元素，所以 CSS 能让每个字符按自己的颜色发一点光（`phosphor`）。配色是 Grok Night，只在 `src/theme.ts` 写一次：xterm.js 直接用它，页面用 Vite 插件写进 `<head>` 的 `--term-*` 变量，Tailwind 再给它们起角色名。字体是 Monaspace Neon；Nerd Font 的图标来自单独的符号字体（`src/fonts/`），终端里出现图标时才下载。界面文字全部是英文，文章是中文。会话走 virtio 控制台（hvc0），窗口大小由它原生同步。第二个串口 ttyS1 是控制通道（`attach` 时按浏览器的时钟和时区设置客户机、启动会话；之后每分钟、以及页面从后台回来时再校一次时），见 `image/rootfs/usr/libexec/home/hostd`。客户机里的 `open` 打印一段私有转义序列，由页面接住、在新标签页打开。客户机经 OSC 52 能往访客的剪贴板里写（Neovim 的复制就是这样出来的），但读不到它。文件可以拖到页面上，或者用客户机里的 `drop` 选，出现在 `~/drop`，按需从访客的磁盘读，不复制。

**联网**（`relay/`、`src/net/`）。客户机有一块 virtio 网卡，平时什么也没接。敲 `net on` 时，页面把它的以太网帧经 WebSocket 交给中继：一个 Rust 写的小服务，每条连接一段私有网段（10.0.2.15，网关 10.0.2.2，DNS 10.0.2.3，和 QEMU 的 user 网络一样），TCP 先连上真实目标再回 SYN，UDP、ping、DNS 都是真的；WebSocket 里还有一层用口令派生密钥的加密，前面的 TLS 终结者看不到帧。详见 [docs/relay.md](docs/relay.md)。另一条路 `net warp` 用浏览器里的 Rust/wasm 客户端直连 Cloudflare WARP（试验，[docs/warp.md](docs/warp.md)）。

**工作台**（`image/workbench/`，[docs/workbench.md](docs/workbench.md)）。客户机里敲 `workbench`，屏幕关掉，换一台 768 MB 的机器开起来，带一块按需读取的工具链盘：gcc、clang、Rust、Go、Python、Node，配好的 Neovim（LazyVim，每种语言的 LSP、格式化、调试），还有 adb 和 fastboot：经 WebUSB 连访客电脑上的手机，客户机里跑的是真正的 adb 和 fastboot。`home` 换回来。

**排版**（`image/rootfs/usr/libexec/home/md.awk`）。`cat` 一个 `.md` 文件到终端时，用 busybox awk 排版：中文可以在字间断行，句末标点悬挂在行尾，代码块是带底色的面板，链接可以点。输出到管道时仍然是原文。

**网页版**（`scripts/lib/blog.ts`）。每篇文章同时生成一个纯静态页面 `/blog/<文章>/`，再加上 `/blog/` 列表和 `/feed.xml`，给搜索引擎、分享链接和 `open` 用。页面没有 JavaScript：顶上是 fish 会打出的那行提示符，正文用 Tailwind Typography 排版，配色和终端相同，和 `cat` 在终端里排的一样。它们的样式表 `src/blog.css` 是单独的构建入口，只收这些页面用到的类。首页的 `<noscript>` 里也列着文章。

**缓存**。`/vm/` 和 `/assets/` 下的文件名都带内容哈希，可以永久缓存（`public/_headers`）。当前用的是哪些文件名，构建时直接打进页面的 JS 里，访问时不用先问服务器。

## 写文章

放进 `content/blog/`，front matter 写 `title`、`date`、`tags`，然后 `npm run build:vm`。`content/` 整体对应客户机里的 `~`。

## 部署

`.github/workflows/build.yml` 会从零构建整站（内核、镜像、快照、页面），用 Chrome 冒烟测试后，上传 `site` 构件。`dist/` 可以放到任意静态托管上：Cloudflare Pages、Netlify 会读取 `_headers`；用 nginx 托管时，用 `deploy/nginx.conf`，规则相同（例如挂进 `nginx:alpine` 容器的 `conf.d/default.conf`）。生成 RSS 的绝对链接需要设置 `SITE_URL`，例如 `https://example.com`。`net on` 还需要中继：一个 Docker 容器，nginx 把 `/relay` 转给它（`deploy/nginx.conf`、`deploy/relay.toml.example`，步骤见 [docs/relay.md](docs/relay.md#部署2026-10-05101)）。

## 实测

| | |
|---|---|
| 首次访问 | 约 6.2 MB（gzip 后）：快照 5.3 MB，v86 的 wasm 385 KB，JS 294 KB（v86 与 xterm.js 185 KB，React 等界面库 103 KB，页面自己 6 KB），CSS 5 KB |
| 本地到出现提示符 | 1.4 秒，其中约 1 秒是开机动画；机器自己 0.3 秒就恢复好了（不含网络） |
| `cat blog/hello.md` | 只请求这一篇，911 B |
| 内核 | 1.6 MB；客户机可用内存 58 MB |
| 整个系统 | 623 个文件块，43 MB，压缩后 9.0 MB，全部按需加载 |
| `net on` | 第一次 3.8 秒（含输入口令），之后 0.7 秒；ping 1.1.1.1 约 38 ms；客户机里下载 2 MB/s |
| `net warp` | 第一次 4 秒连上（含注册），之后 1.7 秒；客户机里下载 1.7 MB/s；WARP 客户端 brotli 后 111 KB，用到才加载 |
| 工作台 | 快照 9.5 MB；工具链盘 758 MB，按需读取；`gcc hello.c` 6 秒，`rustc` 12 秒，`go run` 第一次 13 秒、之后 2 秒，`nvim` 载入全部插件 3 秒 |

## 接下来

待办和优先级见 [TODO.md](TODO.md)；联网见 [docs/relay.md](docs/relay.md)（`net on`）和 [docs/warp.md](docs/warp.md)（`net warp`）；工作台见 [docs/workbench.md](docs/workbench.md)。

## 踩过的坑

- **9p 不缓存**：v86 给所有文件报的版本号都是 0，Linux 6.x 的 9p 客户端因此对每个文件都绕过页缓存。挂载选项要加 `ignoreqv`（见 `vm.config.ts`）。
- **窗口行列反了**：v86 发 virtio 控制台尺寸时按旧内核的（行, 列）顺序，新内核按规范读（列, 行）。`src/machine.ts` 里对调了参数。
- **v86 占掉内存顶部 16 MB**：想给客户机 64 MB 可用内存，要配 80 MB。
- **32 位时间的系统调用**：i386 上的 musl 仍会调用 `pselect6` 这类 32 位时间系统调用，内核必须开 `COMPAT_32BIT_TIME`，否则 fish 一启动就崩。
- **busybox awk 的正则**：用字符串拼出来的动态正则会把反斜杠多处理一遍，所以只能用 `/字面量/`。另外 `match()` 写的是全局的 RSTART/RLENGTH，嵌套调用会互相覆盖。
- **WebGL 渲染器**：xterm.js 的 WebGL 渲染器在高分屏下绘制有问题，改用默认的 DOM 渲染器。
- **快照里的握手不能用 FIFO**：hostd 先置标志、再写 FIFO 叫醒 session；如果 session 被重新拉起时标志已经在了，它就不读 FIFO，hostd 永远卡在打开 FIFO 上，而且被存进快照：之后控制通道全部失灵，时钟也停在构建时间。现在 session 改成轮询标志文件。
- **wasm 里的 rustls**：rustls 的 `std` 特性要读系统时钟，`wasm32-unknown-unknown` 上没有；所以关掉 `std`，改用它的 unbuffered API，时间由页面传进去。
- **在这台开发机上连不上 WARP 入口**：TCP 能连，TLS 一看到 `consumer-masque` 这个 SNI 就被复位。本地开发用 `WARP_EDGE` 走 SSH 转发。
- **命令替换会吞掉转义序列**：fish 的 `set x (f)` 捕获 `f` 的标准输出，`f` 里 printf 的 OSC 就到不了终端。要发给页面的序列写到 stderr。
- **busybox 的 wget 访问 https 要 `ssl_client`**：它是单独的包，没有它 wget 只会报 `can't execute 'ssl_client'`。
- **mtr 要开原始套接字**：访客不是 root，所以 `mtr-packet` 设成 setuid（`image.config.ts` 的 `modes` 现在也作用于包里的文件）。
- **hickory 的 DoT 默认没有根证书**：不开 `webpki-roots` 特性，根证书库是空的，所有 TLS 上游都会失败。
- **xterm.js 量父元素时把内边距也算进去**：Tailwind 的 preflight 让所有元素都是 `border-box`，`getComputedStyle().height` 于是包含内边距，FitAddon 多算出两行，终端伸出屏幕底下、获得焦点时把屏幕顶上去。边距放在外面一层（`components/Terminal.tsx`），屏幕用 `overflow: clip`，不能被滚动。
- **xterm.js 6 留着一条原生滚动条**：它改用自己的滚动实现，样式表却仍给 `.xterm-viewport` 设了 `overflow-y: scroll`，Windows 上就一直画着一条原生滚动条，要 `scrollbar-width: none`。无头 Chrome 默认隐藏滚动条（`--hide-scrollbars`），截图里看不出来；检查滚动条时用 `ignoreDefaultArgs: ["--hide-scrollbars"]` 启动。
- **xterm.js 6 自己涂背景**：底色不再画在 `.xterm-viewport` 上，而是以内联样式写在 `.xterm-scrollable-element` 上，要用 `!important` 去掉，显像管的渐变才透得出来。
- **motion 的分属性过渡会整个替换默认过渡**：给某个属性单独写了 `transition`，外层的 `delay` 对它就不起作用了，延迟要写进每一个属性里。
- **IDE 盘只认主盘**：v86 的 PIIX3 上，接在 `hdb` 的盘内核看不到，工具链盘要接 `hda`。
- **v86 把每个 virtio 端口都说成控制台**：端口 1 到 3 于是都成了终端（hvc），它们的 `/dev/vport*` 打不开（ENXIO）。`src/machine.ts` 拦下 v86 对这几个端口发的这条消息，只有端口 0 是控制台；客户机开机时听到的是什么，快照就记住什么。
- **virtio 端口的设备号不固定**：`/dev/vportNpM` 里的 N 是 virtio 设备的序号（这里是 2），不是控制台的。v86 给每个端口起了名字，`/etc/rc` 像 udev 那样建好 `/dev/virtio-ports/<名字>`，hostd 只用名字。
- **v86 会丢 virtio 控制台的输入**：客户机没有空闲的接收缓冲时，送进去的字节直接扔掉；大段粘贴和 USB 数据都会丢。每个端口改为排队，等客户机有缓冲再送。
- **lazy.nvim 在 i686 的 musl 上崩溃**：它经 LuaJIT 的 FFI 调 `clock_gettime`，按 32 位声明 `time_t`；musl 在 i686 上是 64 位，调用写出了结构体的边界，Neovim 随后崩掉。`image/workbench/nvim/init.lua` 改用 libuv 的 `getrusage` 计时。
- **GCC 编不了大的 tree-sitter 解析器**：tree-sitter 编译时带 `-Wall`，其中的 `-Wuninitialized` 让 32 位的 cc1 在 3.3 MB 的 `parser.c`（gitcommit）上用光 4 GB 地址空间，`-w` 也没用。解析器改用 clang 编（550 MB）。
- **LazyVim 会自己在后台装解析器**：插件一载入就开始编译；构建盘时 Neovim 退出了，编译器还在往缓存里写，下一条 `rm` 就失败，而且时好时坏。构建时用 `g:workbench_build` 让它只交出清单，解析器由单独的一个 Neovim 编。
- **Go 说 `fmt is not in std`**：Go 给每个包目录的索引算哈希时，把文件的修改时间按本地时区格式化进去；客户机用的是访客的时区，构建时存下的索引永远对不上，Go 就要重建索引写回缓存，而缓存属于 root，写失败被当成“包不存在”。缓存改为属于访客。
- **9p 的 `cache=loose` 看不到页面新加的文件**：客户机记得目录里有什么。拖进来的文件先放进一个它从没见过的目录，再由 hostd 改名搬进 `~/drop`。
