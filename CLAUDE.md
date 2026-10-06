# CLAUDE.md

在这个仓库里干活要知道的：命令、约定、各部分怎么做的、部署，和踩过的坑。它是什么、能做什么，见 [README.md](README.md)；各部分的设计在 `docs/`。

## 命令

```sh
npm install
npm run build:kernel   # 在 Docker 里编译内核（image/kernel/）
npm run build:tools    # 在 Docker 里编译 Alpine 没有的工具（image/tools/，i686 的 Alpine 容器）
npm run build:vm       # 镜像、快照、Python 工具启动时读的文件（build:image、build:state、build:prefetch）
npm run dev            # http://localhost:5173
```

本机没有 Docker 时，内核和工具经 ssh 到一台 Linux 主机的 Docker 上编：`BUILD_HOST=<主机> npm run build:kernel`（`scripts/lib/docker.ts`）。改了 `image/` 或 `content/` 要重新 `npm run build:vm`；改了内核配置，先 `build:kernel`。

| 命令 | 作用 |
|---|---|
| `npm run shell` | 从本地终端连进这台机器（Ctrl-] 退出） |
| `npm run shell -- -c "uname -a"` | 跑一条命令；加 `--trace` 看客户机通过 9p 读了哪些文件 |
| `npm run shell -- --put 本地路径=/mnt/x -c "..."` | 先把本地文件放进客户机再跑，改脚本不用重建镜像（Git Bash 下要设 `MSYS_NO_PATHCONV=1`） |
| `npm run smoke [url]` | 用本机 Chrome 端到端测一遍，截图在 `.cache/smoke/` |
| `npm run check:serial` | 给机器插几根假的串口线：一根 USB 转串口线，用客户机里的 stty、python3 把速度、帧格式、数据和各条信号线走一遍；一块停在 U-Boot `loady` 的板子，`sb` 往里传文件；一个蓝牙串口，走远再回来（[docs/serial.md](docs/serial.md)） |
| `npm run check:ble` | 给机器几台假的蓝牙 LE 设备：Nordic UART、HM-10、自定的服务，经 `/dev/ttyBLE0` 往返字节，走远再回来 |
| `npm run check:files` | 把文件从机器里 `take` 出来：存成它本身、打成 zip、ZIP64、手机上的下载，存下来的再拖回去让 Python 验 CRC；再共享一个假文件夹进去，读、写、改名、删，放开后一个文件也不少（[docs/files.md](docs/files.md)） |
| `npm run check:usb` | 给机器插几台假 USB 设备，连描述符都有，客户机的内核经 USB/IP 枚举它们：一台手机给 adb 和 fastboot，一台 DFU 设备给 dfu-util（[docs/usb.md](docs/usb.md)） |
| `npm run lint` / `npm run typecheck` / `npm run build` | oxlint / 类型检查 / 先类型检查再生产构建，产物在 `dist/` |
| `cargo test --manifest-path relay/Cargo.toml` | 中继的测试：一台 smoltcp 访客经真实的 WebSocket 连进中继，两个族各测一遍 |
| `RELAY=host:port npm run dev` | 开发服务器把 `/relay` 转给那里的中继（默认 127.0.0.1:8095，[docs/relay.md](docs/relay.md)） |
| `npm test --prefix press` | press 的测试：软件实现的通行密钥、模拟的 GitHub、和中继对齐的 token |
| `PRESS=host:port npm run dev` | 开发服务器把 `/api/` 转给那里的 press（默认 127.0.0.1:8096，[docs/login.md](docs/login.md)） |
| `npm run check:login` | 先 `npm run build`：本机起中继和 press，Chrome 的虚拟认证器扮通行密钥，在客户机里把登录和中继（IPv6 也在内）走一遍 |
| `npm run check:writing` | 同样先 `npm run build`：在客户机里写一篇带图的文章、发布、发一条动态，再换一台刚恢复的机器看它们在不在 |

中继测试里有几项只在 Linux 上跑：ping socket（要 `net.ipv4.ping_group_range` 包含当前用户的组，容器里默认就是）和 `IP_RECVERR`、`IPV6_RECVERR`。Windows 上它们跳过；在 Linux 的容器里跑全：`docker run --rm -v ./relay:/src -w /src rust:1-alpine sh -c "apk add musl-dev && cargo test"`。

页面加 `?cold` 会冷启动内核，而不是恢复快照（调试用）。

## 约定

- 代码全用 TypeScript，构建脚本和检查也是，Node 26 直接跑 `.ts`；中继是 Rust。
- 界面文字英文；文章、文档用中文，和站长说话也用中文。注释用英文，写为什么，不复述代码。
- 提交信息用英文，第三人称，像人写的（“Renames …”、“Brings …”），正文讲为什么；不署 AI（不加 Co-Authored-By），不用 emoji。
- 客户机里的 fish 保持原装的样子：自带的脚本只按名字用颜色（`cyan`、`brblack`……），颜色长什么样由 `src/theme.ts` 定。
- 中继和 press 的协议标签 `guest@home relay v1`、`guest@home session v1`、`guest@home channel v1` 在每一把密钥里，是机器的旧名字，不能改。
- 会话密钥、GitHub 的 client secret 只在服务器上，不进仓库、文档和提交：仓库是公开的。
- 工作台和 `net warp` 已封存（2026-10-05）：代码原样留着，不构建、不部署，客户机里也没有入口；解封见 [docs/workbench.md](docs/workbench.md)、[docs/warp.md](docs/warp.md) 开头。
- 大的改动先给方案（界面先出设计图），站长同意再做；部署和服务器上的改动要站长点头。

## 部署

- 推到 `main`、CI 全部通过之后，`.github/workflows/build.yml` 把 `ghcr.io/nettomew/pien-relay`、`-press`、`-site` 推到 GitHub 的容器仓库，打上提交的七位前缀和 `main`。服务器上由站长手动跑 `pien-deploy <提交>`（`deploy/pien-deploy`，`--check` 只拉下来看一眼）。从零怎么部署（用 Docker 或不用）、本站现在的样子，见 [docs/deploy.md](docs/deploy.md)。
- 服务器上的容器叫 `homepage-relay`、`homepage-press`、`homepage-demo`（nginx）、`homepage-caddy`，接在双栈的 Docker 网络 `homepage` 上：容器名解析出两个地址：Caddy 先拨 IPv6，所以 nginx 两个族都要听；nginx 找中继和 press 只问 IPv4。服务器上只动这几个容器。
- 对外的地址是 arc.moe，页面开在 www.arc.moe：arc.moe 由 Cloudflare 301 过去，www 前面是朋友自建的 CDN，回源走 HTTPS，源站的证书是 Caddy 自签的（`tls internal`）。所以 `SITE_URL`（仓库变量）是 `https://arc.moe`，press 的 `PRESS_SITE` 是 `https://www.arc.moe`、`PRESS_RP_ID` 是 `arc.moe`（通行密钥跟着整个域走）。
- 被绑定挂载着的目录不能 `rm -rf` 了再重建：跑着的容器还拿着删掉的那个。站点换上去以后要重启 nginx 和 press。
- 线上的中继只认站长的登录。要用真的客户机试它，就在同一台机器、同一个网络上用同一个镜像临时起一个带自己密钥的中继，只发布到 127.0.0.1，经 ssh 转发过来，在 `vite preview` 里 `net relay ws://127.0.0.1:<端口>/`，用完删掉。

## 各部分怎么做的

**内核**（`image/kernel/`）。在 `allnoconfig` 上只开 v86 需要的东西：四个串口（内核日志、控制通道、访客借来的串口、蓝牙 LE 串口）、virtio 控制台、经 virtio 走的 9p，virtio 网卡和 IPv4、IPv6，USB 核心和 USB/IP 的虚拟主控制器 vhci-hcd，再加上工作台那块盘要的 IDE（`ata_piix`）、squashfs 和 overlayfs。全部编进内核，内核自己把浏览器提供的 9p 目录挂成根文件系统，不需要模块，也不需要 initramfs。编译在一次性的 Alpine 容器里进行，版本和源码校验和都固定。

**镜像**（`scripts/build-image.ts`）。只用 Node：读 Alpine x86 仓库的索引，解出依赖（连同 install_if 带进来的，比如每个 Python 包的字节码），解包，叠上 `image/rootfs/`、`content/` 和 `image/tools/` 里另外编译好的工具（`npm run build:tools`），输出：

- 一份目录树，只有元数据；
- 每个文件一个块，按内容哈希命名，客户机第一次读到时才下载；
- 每个程序启动时要读的文件：它要加载的共享库（读 ELF 的 DT_NEEDED，一路追下去，`scripts/lib/libraries.ts`）；Python 写的工具不说自己要什么，一启动就 import 几百个模块，就在一台从快照恢复的机器里把它们各跑一次，记下读了哪些（`scripts/build-prefetch.ts`）。客户机第一次读到某个程序时，页面把这些一起取来（`src/prefetch.ts`），而不是等动态链接器、Python 一个接一个地要，一个一来回。musl 和 fish 自己用的库本来就在内存里，不算在内。

客户机里的 fish 是原装的：提示符、配色、补全都没改，只关掉了欢迎语。自带的脚本和 `md.awk` 也只按名字用颜色（`cyan`、`brblack`……），每种颜色长什么样，由终端的调色板（`src/theme.ts`）决定。主机名在 `image/image.config.ts`，`/etc/hostname`、`/etc/hosts` 和页面标题都从它来。

**快照**（`scripts/build-state.ts`）。在 Node 里冷启动一次，先用一个一次性的会话把常用的东西预热进页缓存，再开一个全新会话、从第一个字节起录下终端输出。等它停在提示符时，整机存成快照，录下的输出另存。访客恢复快照后，页面回放这段输出，fish 已经在提示符等着了。

**页面**（`src/`）。从 Vite 官方模板（React + TypeScript）起步，样式用 Tailwind。机器和终端都在 React 之外，一页只有一份：`session.ts` 在页面一打开时就开始加载 v86，`terminal.ts` 持有 xterm.js，两者之间的状态（加载进度、标题）放在一个 zustand store 里。React 只画屏幕：CRT 的显像管和玻璃（`components/Screen.tsx`），开机动画（`Boot.tsx`，motion：亮点、扫描线、画面过亮地展开，再滚过一屏开机日志。日志是编的（`boot-log.ts`），节奏却是真的：每一行代表要下载的东西里的一份，下完日志也走完，最后一项服务等机器真正就绪才打上 `ok`；画面展开时机器已经就绪，就直接到提示符），触屏设备上屏幕下方的一排快捷键（`Keys.tsx`，Lucide 图标），以及客户机要用到浏览器授权时浮出的那枚键（`Offer.tsx`、`src/gesture.ts`：手机只在点按的那一刻允许弹窗和选文件，命令传到页面时已经晚了，点一下这枚键就补上）。终端用 DOM 渲染器，每个字符都是一个元素，所以 CSS 能让每个字符按自己的颜色发一点光（`phosphor`）。配色是 Grok Night，只在 `src/theme.ts` 写一次：xterm.js 直接用它，页面用 Vite 插件写进 `<head>` 的 `--term-*` 变量，Tailwind 再给它们起角色名。字体是 Monaspace Neon；Nerd Font 的图标来自单独的符号字体（`src/fonts/`），终端里出现图标时才下载。界面文字全部是英文，文章是中文。会话走 virtio 控制台（hvc0），窗口大小由它原生同步。第二个串口 ttyS1 是控制通道（`attach` 时按浏览器的时钟和时区设置客户机、启动会话；之后每分钟、以及页面从后台回来时再校一次时），见 `image/rootfs/usr/libexec/home/hostd`。客户机里的 `open` 打印一段私有转义序列，由页面接住、在新标签页打开。客户机经 OSC 52 能往访客的剪贴板里写（Neovim 的复制就是这样出来的），但读不到它。文件可以拖到页面上，或者用客户机里的 `drop` 选，出现在 `~/drop`，按需从访客的磁盘读，不复制；反过来，`take` 把客户机里的文件存到访客的电脑上，一个文件是它本身，一个目录或几样东西打成 zip；`share` 把访客电脑上的一个文件夹接到 `/mnt` 下面，能读能写（[docs/files.md](docs/files.md)）。

**联网**（`relay/`、`src/net/`）。客户机有一块 virtio 网卡，平时什么也没接。敲 `net on` 时，页面把它的以太网帧经 WebSocket 交给中继：一个 Rust 写的小服务，每条连接一段私有网段（10.0.2.15，网关 10.0.2.2，DNS 10.0.2.3，和 QEMU 的 user 网络一样），旁边还有一段 IPv6（`fdca:c697:4c23::/64`，网关发路由通告，客户机自己生成地址），TCP 先连上真实目标再回 SYN，UDP、ping、traceroute、DNS 都是真的，两个族都一样；WebSocket 里还有一层加密，前面的 TLS 终结者看不到帧。本站的中继只认站长的登录；谁都可以搭自己的中继（`relay key` 给它一把密钥），用 `net relay <地址>` 指过去。详见 [docs/relay.md](docs/relay.md)。

**登录**（`press/`、`src/account/`，[docs/login.md](docs/login.md)）。只有站长一个账号，没有口令：通行密钥是正门，GitHub 是从新设备回来的后门，弹出窗口里走完，页面和机器都不动。第一个通行密钥要服务器给的一次性码（`press enroll`）。press 是一个 TypeScript 小服务；它签发的登录是自证的 token，中继拿同一把会话密钥自己验，不用问谁。客户机里的命令经一条带暗号的问答通道问页面（`src/ask.ts`），终端里显示出来的文字冒充不了。

**编辑器**。nano，和 [Microsoft Edit](https://github.com/microsoft/edit)（`edit`，也叫 `msedit`）。Edit 不在 Alpine 的仓库里，`image/tools/edit/build.sh` 在 i686 的 Alpine 容器里从固定的版本编译它，链接客户机自己的 musl；查找替换要的 ICU 用到才读。

**USB 设备**（`src/usb/`，[docs/usb.md](docs/usb.md)）。访客电脑上的 USB 设备经 USB/IP 交给客户机：页面是一个 usbipd，客户机内核里的 vhci-hcd 把设备当成插在自己身上的来枚举，adb、fastboot、dfu-util、openocd、flashrom、picotool，还有瑞芯微、全志、联发科、高通的刷机工具照常用它们，用到时自己去借。

**工作台**（`image/workbench/`，已封存）。一台 768 MB 的大机器，带一块按需读取的工具链盘：gcc、clang、Rust、Go、Python、Node，配好的 Neovim。

**串口**（`src/serial/`，[docs/serial.md](docs/serial.md)）。客户机里敲 `serial`，访客电脑上的 USB 转串口线就成了 `/dev/ttyUSB0`，配对过的蓝牙串口成了 `/dev/rfcomm0`，用 tio 连；`ble` 经 Web Bluetooth 连蓝牙 LE 的串口模块（Nordic UART、HM-10 这些），成了 `/dev/ttyBLE0`。背后是 v86 模拟的一颗 16550（客户机的 ttyS2）：客户机的驱动设的速度、帧格式、DTR、RTS、break，页面从芯片寄存器上读出来，经 Web Serial 设到真的线上，1500000 这样的速度也是精确的；CTS、DSR、DCD、RI 反过来传回客户机。lrzsz、esptool、mpremote、stm32flash、avrdude 都在，用到串口时自己去借。

**排版**（`image/rootfs/usr/libexec/home/md.awk`）。`cat` 一个 `.md` 文件到终端时，用 busybox awk 排版：中文可以在字间断行，句末标点悬挂在行尾，代码块是带底色的面板，链接可以点，单独一行的图片直接画在终端里（iTerm2 的内联图片序列，页面用 `@xterm/addon-image` 画）。输出到管道时仍然是原文。

**写作**（`press/src/writing.ts`、`src/writing.ts`，[docs/writing.md](docs/writing.md)）。站长登录后在机器里写：`blog edit <名字>` 在编辑器里写文章，草稿存在服务器上，拖进来的图片随草稿送去（摆正、去掉 EXIF、存成 JPEG），`blog publish` 发布；`moments new` 发一条动态（`now.md` 已经并进动态）。press 把发布的内容放在一个 git 仓库里，一次一个提交，再渲染出网页和 `/content/`。页面打开时比较服务器的内容索引和机器构建时的那份，只把差别作为按需下载的文件铺进 `~`，所以不用重建虚拟机，访客的机器里也是最新的。

**网页版**（`scripts/lib/blog.ts`）。每篇文章同时生成一个纯静态页面 `/blog/<文章>/`，再加上 `/blog/` 列表、`/moments/` 动态和 `/feed.xml`，给搜索引擎、分享链接和 `open` 用；构建时生成一份，press 在内容变化时再渲染一份，nginx 优先用后者，图片按屏幕宽度从三种 WebP 里选。页面没有 JavaScript：顶上是 fish 会打出的那行提示符，正文用 Tailwind Typography 排版，配色和终端相同，和 `cat` 在终端里排的一样。它们的样式表 `src/blog.css` 是单独的构建入口，只收这些页面用到的类。首页的 `<noscript>` 里也列着文章。

**缓存**。`/vm/` 和 `/assets/` 下的文件名都带内容哈希，可以永久缓存（`public/_headers`）。当前用的是哪些文件名，构建时直接打进页面的 JS 里，访问时不用先问服务器。

仓库里的 `content/` 是种子：镜像按它构建，服务器上的内容仓库也从它开始；它整体对应客户机里的 `~`，改了要 `npm run build:vm`。

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
- **fish 第一次启动会跑 Python**：fish 4 把从手册页生成补全的脚本编进了自己的二进制，第一次交互启动时只要有 python3 就在后台跑它，排除 `/usr/share/fish/tools` 也拦不住。镜像里没有手册页，这一趟白跑，还把 5 MB 的 libpython 留在快照里（home 的快照因此从 5.4 MB 涨到 6.8 MB）。`/etc/rc` 先建好它要填的目录 `~/.cache/fish/generated_completions`，它就不跑了。
- **Web Serial 只在打开时收速度**：改速度、帧格式都得把串口关了再按新设置打开。客户机的 8250 驱动每次改完设置，最后一步都是在关上分频锁存的情况下写一次线路控制寄存器；页面在 v86 的这个寄存器字段上装了一个访问器，正好在这一刻知道该重开了，用不着轮询。
- **USB/IP 慢得出奇**：推 8 MB 要 1.8 秒，原来的桥 0.3 秒。内核每个请求都等一个 48 字节的回答，socat 那一头的 TCP 没设 `nodelay`，这些小回答都被 Nagle 算法和延迟确认拖住。设上之后 0.34 秒。
- **usbip 说 attach 失败，内核却已经接上了**：它最后要把连接记在 `/var/run/vhci_hcd` 里，镜像里没有 `/var/run`（那是 Alpine 的 baselayout 建的），记不下就报失败，hostd 只好又把设备拔掉。镜像里补上了 `/var/run` 指向 `/run`。
- **拖进来的文件只能读一次**：客户机每次关上一个文件，v86 都叫存储 uncache 一次，不只是写的时候；页面原来一听到就把读法扔了，再读就去服务器上找一个并不存在的文件。客户机的页缓存常常挡在前面，内核大了一点、内存紧了才露出来。现在只在 inode 已经不在“别处”（写过了）时才扔。
- **写给共享文件夹的东西半分钟后才到**：9p 用 `cache=loose` 时，客户机写的东西先在页缓存里，到了 Linux 默认的 30 秒才写回 9p；开着不关的文件，页面半分钟都看不到它变。`/etc/rc` 把这段时间改成 2 秒。
- **v86 的 UART 把收到的字节全攒着**：串口没有程序开着时，真的 16550 收满 16 字节的 FIFO 就丢，驱动打开时还会清空；v86 不管 FIFO 的清空位，收到多少攒多少，一台不停说话的设备能把内存攒满，下一个打开串口的程序先读到一大堆旧字节。页面看着 OUT2（驱动开着串口时拉高）：没人开着，字节就不往里送。
- **内核不认第四个串口**：x86 上 COM4 的探测要做回环测试，COM1 到 COM3 都跳过。v86 的 UART 回环只回字节、不把 DTR、RTS 回到 CTS、DSR 上，测试不过，ttyS3 的节点在、口却是空的。`/etc/rc` 用 `setserial /dev/ttyS3 uart 16550A` 告诉它。
- **16550 的速度只到 115200**：默认时钟除以 16 再除以分频，分频最小是 1。`/etc/rc` 用 `setserial` 把 ttyS2 的时钟调高到 24 MHz（除以 16 之后），1500000、3000000 都成了整数分频；差一点点的（115200 这类）由页面对回标准速度。
- **Web Serial 丢了设备时不出声**：读流出错后 `port.readable` 变成 null，读循环就静静地停了。USB 线还有 `disconnect` 事件报信，蓝牙设备走远了什么事件也没有，要到客户机下次写才会发现。读循环现在在流一个也不剩时报“坏了”，蓝牙的由页面隔一会儿重开。
- **装好的 Python 包会在每次运行时重编字节码**：客户机里的访客写不了 `/usr/lib/python3.14`，`__pycache__` 写不进去，每次 import 都在模拟的 CPU 上从源码编一遍。Alpine 的字节码在单独的 `-pyc` 包里，靠 install_if 跟着 `pyc` 装，镜像的依赖解析因此学会了 install_if；`image/tools/python/` 装的几个包，构建时用不核对源码时间的字节码（`unchecked-hash`）编好。
- **smoltcp 的 SLAAC 有一条 IPv4 路由就不加 IPv6 的**：它往路由表里添路由前，要确认表里没有相同的，可这个判断对 IPv4 路由一律答“不行”，于是只要先有一条 IPv4 默认路由，通告里的 IPv6 默认路由永远加不进去。中继自己不用 SLAAC；测试里扮访客的 smoltcp 要用，就先等通告配好 IPv6，再加 IPv4 路由（`relay/tests/relay.rs`）。
- **Docker 网络改成双栈后，Caddy 拨不通 nginx**：容器名在双栈网络上解析出两个地址，Caddy 先拨 IPv6 的那个，nginx 只听 IPv4，被拒之后也不改拨，整站 502。`deploy/nginx.conf` 两个族都听。
- **Chrome 在标签页里先拿走 Ctrl+T、Ctrl+W、Ctrl+N**：这几个是浏览器的保留键（`chrome/browser/ui/browser_command_controller.cc` 的 `IsReservedCommandOrKey`），根本不交给页面，`preventDefault` 也没用。tio 的命令键 Ctrl+T 因此用不了，改成了 Ctrl+G（`image/home/.config/tio/config`，`image/home/` 照 /etc/skel 的意思铺进 `~`，属主是 guest）；shell 和 nano 里常按的 Ctrl+W 会直接关掉页面，所以访客敲过东西之后，`beforeunload` 先问一句。全屏时，或者在装成应用的窗口里（`public/manifest.webmanifest`），保留键一个都没有，全交给终端。
