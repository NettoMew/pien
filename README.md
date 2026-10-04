# guest@home

一台运行在浏览器里的、真正的 Linux，当作个人主页。Alpine 3.24 用户空间，自己编译的 6.18 内核，fish 4.6，跑在 [v86](https://github.com/copy/v86) 里。

```sh
npm install
npm run build:warp     # 用 Rust 编 WARP 客户端（wasm）；先 rustup target add wasm32-unknown-unknown
npm run build:kernel   # 在 Docker 里编译内核；本机没有 Docker 时：KERNEL_HOST=<Linux 主机> npm run build:kernel
npm run build:vm       # 构建镜像，再在 Node 里开机、存快照（约 30 秒）
npm run dev            # http://localhost:5173
```

| 命令 | 作用 |
|---|---|
| `npm run shell` | 从本地终端连进这台机器（Ctrl-] 退出） |
| `npm run shell -- -c "uname -a"` | 跑一条命令；加 `--trace` 看客户机通过 9p 读了哪些文件 |
| `npm run shell -- --put 本地路径=/mnt/x -c "..."` | 先把本地文件放进客户机再跑，改脚本不用重建镜像（Git Bash 下要设 `MSYS_NO_PATHCONV=1`） |
| `npm run smoke [url]` | 用本机 Chrome 端到端测一遍，截图在 `.cache/smoke/` |
| `npm run typecheck` / `npm run build` | 类型检查 / 生产构建，产物在 `dist/` |
| `cargo test --manifest-path relay/Cargo.toml` | 中继的测试：一台 smoltcp 访客经真实的 WebSocket 连进中继 |
| `RELAY=host:port npm run dev` | 开发服务器把 `/relay` 转给那里的中继（默认 127.0.0.1:8095，见 docs/relay.md） |
| `npm run warp -- register` / `delete` | 注册或删除一个开发用的 WARP 设备，配合 `warp/examples/edge.rs` 直连入口（见 [docs/warp.md](docs/warp.md)） |
| `WARP_EDGE=host:port npm run dev` | 本机连不上 WARP 入口时，让开发服务器走别的路径，比如一条 SSH 转发 |

页面加 `?cold` 会冷启动内核，而不是恢复快照（调试用）。

## 怎么工作的

**内核**（`image/kernel/`）。在 `allnoconfig` 上只开 v86 需要的东西：两个串口、virtio 控制台、经 virtio 走的 9p。全部编进内核，内核自己把浏览器提供的 9p 目录挂成根文件系统，不需要模块，也不需要 initramfs。编译在一次性的 Alpine 容器里进行，版本和源码校验和都固定。

**镜像**（`scripts/build-image.ts`）。只用 Node：读 Alpine x86 仓库的索引，解出依赖，解包，叠上 `image/rootfs/` 和 `content/`，输出：

- 一份目录树，只有元数据；
- 每个文件一个块，按内容哈希命名，客户机第一次读到时才下载。

**快照**（`scripts/build-state.ts`）。在 Node 里冷启动一次，先用一个一次性的会话把常用的东西预热进页缓存，再开一个全新会话、从第一个字节起录下终端输出。等它停在提示符时，整机存成快照，录下的输出另存。访客恢复快照后，页面回放这段输出，fish 已经在提示符等着了。

**页面**（`src/`）。xterm.js 渲染终端，字体是 Monaspace Neon；Nerd Font 的图标来自单独的符号字体（`src/fonts/`），终端里出现图标时才下载。界面文字全部是英文，文章是中文。会话走 virtio 控制台（hvc0），窗口大小由它原生同步。第二个串口 ttyS1 是控制通道（`attach` 时按浏览器的时钟和时区设置客户机、启动会话；之后每分钟、以及页面从后台回来时再校一次时），见 `image/rootfs/usr/libexec/home/hostd`。客户机里的 `open` 打印一段私有转义序列，由页面接住、在新标签页打开。底部状态栏通过浏览器的资源计时，实时显示每一次按需加载。触屏设备上多一排快捷键：Tab、↑、Ctrl-C 和几个常用命令。

**联网**（`relay/`、`src/net/`）。客户机有一块 virtio 网卡，平时什么也没接。敲 `net on` 时，页面把它的以太网帧经 WebSocket 交给中继：一个 Rust 写的小服务，每条连接一段私有网段（10.0.2.15，网关 10.0.2.2，DNS 10.0.2.3，和 QEMU 的 user 网络一样），TCP 先连上真实目标再回 SYN，UDP、ping、DNS 都是真的；WebSocket 里还有一层用口令派生密钥的加密，前面的 TLS 终结者看不到帧。详见 [docs/relay.md](docs/relay.md)。另一条路 `net warp` 用浏览器里的 Rust/wasm 客户端直连 Cloudflare WARP（试验，[docs/warp.md](docs/warp.md)）。

**排版**（`image/rootfs/usr/libexec/home/md.awk`）。`cat` 一个 `.md` 文件到终端时，用 busybox awk 排版：中文可以在字间断行，句末标点悬挂在行尾，代码块是带底色的面板，链接可以点。输出到管道时仍然是原文。

**网页版**（`scripts/lib/blog.ts`）。每篇文章同时生成一个纯静态页面 `/blog/<文章>/`，再加上 `/blog/` 列表和 `/feed.xml`，给搜索引擎、分享链接和 `open` 用。首页的 `<noscript>` 里也列着文章。

**缓存**。`/vm/` 和 `/assets/` 下的文件名都带内容哈希，可以永久缓存（`public/_headers`）。当前用的是哪些文件名，构建时直接打进页面的 JS 里，访问时不用先问服务器。

## 写文章

放进 `content/blog/`，front matter 写 `title`、`date`、`tags`，然后 `npm run build:vm`。`content/` 整体对应客户机里的 `~`。

## 部署

`.github/workflows/build.yml` 会从零构建整站（内核、镜像、快照、页面），用 Chrome 冒烟测试后，上传 `site` 构件。`dist/` 可以放到任意静态托管上：Cloudflare Pages、Netlify 会读取 `_headers`；用 nginx 托管时，用 `deploy/nginx.conf`，规则相同（例如挂进 `nginx:alpine` 容器的 `conf.d/default.conf`）。生成 RSS 的绝对链接需要设置 `SITE_URL`，例如 `https://example.com`。`net on` 还需要中继：一个 Docker 容器，nginx 把 `/relay` 转给它（`deploy/nginx.conf`、`deploy/relay.toml.example`，步骤见 [docs/relay.md](docs/relay.md#部署2026-10-05101)）。

## 实测

| | |
|---|---|
| 首次访问 | 约 6.1 MB（gzip 后）：快照 5.3 MB，v86 的 wasm 381 KB，JS 188 KB |
| 本地到出现提示符 | 0.3 秒（不含网络） |
| `cat blog/hello.md` | 只请求这一篇，911 B |
| 内核 | 1.6 MB；客户机可用内存 58 MB |
| 整个系统 | 623 个文件块，43 MB，压缩后 9.0 MB，全部按需加载 |
| `net on` | 第一次 3.8 秒（含输入口令），之后 0.7 秒；ping 1.1.1.1 约 38 ms；客户机里下载 2 MB/s |
| `net warp` | 第一次 4 秒连上（含注册），之后 1.7 秒；客户机里下载 1.7 MB/s；WARP 客户端 brotli 后 111 KB，用到才加载 |

## 接下来

待办和优先级见 [TODO.md](TODO.md)；联网见 [docs/relay.md](docs/relay.md)（`net on`）和 [docs/warp.md](docs/warp.md)（`net warp`）。

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
- **欢迎语不能重排**：欢迎语是构建时录下、原样回放的，所以每行都控制在手机能放下的宽度。
