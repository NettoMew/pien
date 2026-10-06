# pien

一台运行在浏览器里的、真正的 Linux，当作个人主页：https://arc.moe。机器叫 zutto-issho，访客进来就是 `guest@zutto-issho`。Alpine 3.24 用户空间，自己编译的 6.18 内核，fish 4.6，跑在 [v86](https://github.com/copy/v86) 里。

- 读文章：`cat` 在终端里排版，图片直接画在终端里；每篇也有不用 JavaScript 的网页版和 RSS。
- 站长登录（通行密钥，或者 GitHub）后就在机器里写文章、发动态，发布了，访客的机器里马上就有。
- `net on` 联网：经中继拿到 IPv4 和一个自己的公网 IPv6 地址，`curl`、`git`、`ssh`、真的 `ping` 和 `mtr` 都能用。
- 把访客电脑上的串口线、蓝牙串口、USB 设备借给机器：tio、esptool、adb、fastboot、dfu-util 和各家的刷机工具照常用。
- 文件拖进来、`take` 存到访客的电脑上、`share` 把访客的一个文件夹接进来，能读能写。

## 跑起来

```sh
npm install
npm run build:kernel   # 在 Docker 里编译内核；本机没有 Docker 时：BUILD_HOST=<Linux 主机> npm run build:kernel
npm run build:tools    # 同样在 Docker 里，编译 Alpine 没有的工具
npm run build:vm       # 构建镜像，再开一次机，存一份快照
npm run dev            # http://localhost:5173
```

检查、测试和其余命令，写代码的约定，还有踩过的坑，都在 [CLAUDE.md](CLAUDE.md)。

## 怎么工作的

**机器**（`image/`、`scripts/build-*.ts`）。内核在 `allnoconfig` 上只开 v86 用得到的东西，全部编进去，不要模块，也不要 initramfs。镜像只用 Node 拼出来：Alpine 的包、`image/rootfs/`、`content/`，加上另外编译的工具；每个文件是一个按内容命名的块，客户机第一次读到才下载，程序启动要读的一串文件由页面一起取来。构建时在 Node 里开一次机，停在提示符时存成快照：访客打开页面，恢复的就是它，fish 已经在等着了。

**页面**（`src/`）。React 画一台 CRT 显示器，终端是 xterm.js，机器和终端都在 React 之外。页面和客户机之间有一条控制通道（第二个串口）、几段私有的转义序列，和一条带暗号的问答通道，终端里显示出来的文字冒充不了。

**联网**（`relay/`、`src/net/`，[docs/relay.md](docs/relay.md)）。`net on` 把客户机网卡的以太网帧经 WebSocket 交给中继：一个 Rust 写的小服务，每条连接一段私有网段，像 QEMU 的 user 网络；IPv6 是每个会话自己的一个地址，中继有公网前缀时就是公网的，出门也用它。TCP 先连上真实目标再回客户机的 SYN，UDP、ping、traceroute、DNS 都是真的；WebSocket 里还有一层加密。本站的中继只认站长的登录，谁都可以搭自己的中继，`net relay <地址>` 指过去。

**登录和写作**（`press/`，[docs/login.md](docs/login.md)、[docs/writing.md](docs/writing.md)）。press 是一个 TypeScript 小服务：只有站长一个账号，通行密钥是正门，GitHub 是从新设备回来的后门。文章和动态在机器里写，草稿存在服务器上，发布进一个 git 仓库，再渲染成网页；页面打开时把服务器上新的东西铺进客户机的 `~`，不用重建虚拟机。

**设备**（`src/serial/`、`src/ble/`、`src/usb/`，[docs/serial.md](docs/serial.md)、[docs/usb.md](docs/usb.md)）。`serial` 把 USB 转串口线、蓝牙串口接成 `/dev/ttyUSB0`、`/dev/rfcomm0`，`ble` 把蓝牙 LE 的串口模块接成 `/dev/ttyBLE0`；客户机设的速度、帧格式和各条信号线，页面从模拟的 16550 上读出来，设到真的线上。USB 设备经 USB/IP 交给客户机，页面就是那个 usbipd。工具用到设备时自己去借。

**文件**（[docs/files.md](docs/files.md)）。拖进来的文件按需从访客的磁盘读，不复制；`take` 把客户机里的文件存出去，目录打成 zip；`share` 进来的文件夹，客户机里的改动写回访客的电脑。

## 实测

| | |
|---|---|
| 首次访问 | 约 7.1 MB（压缩后，2026-10-06 在 arc.moe 上量的）：快照 6.2 MB，JS 358 KB，v86 的 wasm 353 KB，字体 90 KB，CSS 6 KB，页面和文件索引 172 KB；串口、蓝牙、USB、take、share 的代码用到才加载，各 2 到 4 KB |
| 本地到出现提示符 | 1.5 秒，其中约 1 秒是开机动画；机器自己 0.3 秒就恢复好了（不含网络）；从 arc.moe 打开约 3 秒 |
| `cat blog/hello.md` | 只请求这一篇，911 B |
| 内核 | 2.0 MB，四个串口、USB/IP、IPv6；客户机可用内存 58 MB |
| 整个系统 | 7782 个文件块，247 MB，压缩后 70 MB，全部按需加载；其中 54 MB 是 mtkclient 给各型联发科芯片的 loader，用到哪个读哪个 |
| `net on` | 2.3 秒，含问 Cloudflare 出口在哪；IPv6 地址同时就有；`ping -6` Cloudflare 约 76 ms（本机在香港，当时的中继在东京） |
| 串口 | 假线上 64 KB 在 1500000 波特下往返 1.4 秒；`sb` 往假 U-Boot 传 50 KB 1.5 秒；页面这一侧用到才加载 |
| 程序第一次运行 | 网络延迟 100 ms 时，`adb version` 9.0 秒 → 2.7 秒（它要 57 个库），`curl --version` 2.7 秒 → 1.7 秒，`esptool version` 52.9 秒 → 15.9 秒（352 个文件）：页面把它们一起取来 |

## 浏览器

页面和机器只用标准的 Web 接口，现代浏览器里都应该能跑，但只在 Chrome（含手机模拟）上实测过；接访客的设备，要看浏览器给不给。

| | 电脑上的 Chrome、Edge | Android 上的 Chrome | Firefox（未实测） | Safari，含 iOS 上的所有浏览器（未实测） |
|---|---|---|---|---|
| 终端、联网、登录、写文章 | 能 | 能 | 能 | 能 |
| `drop` 拿进文件 | 能，拖进来或选 | 能，选 | 能 | 能 |
| `take` 存出去 | 能，选地方，边读边写 | 能，下载 | 能，下载 | 能，下载 |
| `share` 共享文件夹 | 能 | — | — | — |
| `serial` USB 转串口线 | 能 | — | — | — |
| `serial` 经典蓝牙串口 | 能 | 能 | — | — |
| `ble` 蓝牙 LE 串口 | 能 | 能 | — | — |
| `usb`、adb、fastboot 和各家刷机工具 | 能 | 能 | — | — |

在标签页里，Chrome 先把 Ctrl+T、Ctrl+W、Ctrl+N 拿去开、关标签页和窗口，页面拦不住：访客在终端里敲过东西之后，关页面前会先问一句；想让这几个键也交给终端，就把它装成应用（地址栏右边的安装按钮），或者全屏。客户机里 tio 的命令键因此是 Ctrl+G。

这些接口（Web Serial、Web Bluetooth、WebUSB、File System Access）只有 Chromium 实现了；没有的时候，命令会说明白是浏览器不支持，而不是坏了。Windows 上 USB 设备还要换成 WinUSB 驱动，见 [docs/usb.md](docs/usb.md)。

## 部署

推到 `main` 之后，GitHub Actions（`.github/workflows/build.yml`）从零构建整站、跑完全部检查，再把中继、press 和站点各做成一个镜像，发布到 `ghcr.io/nettomew/pien-*`；没变的东西不重做，各自按来源缓存。

怎么部署：用 Docker、不用 Docker、只放静态站点，见 [docs/deploy.md](docs/deploy.md)。模板都在 `deploy/`：Caddy 和 nginx 的配置、systemd 服务、press 和中继的配置样例，还有更新用的 `pien-deploy`。

## 文档

- [TODO.md](TODO.md)：待办和优先级
- [docs/deploy.md](docs/deploy.md)：部署，用 Docker 或不用，和本站现在的样子
- [CLAUDE.md](CLAUDE.md)：命令、约定、各部分怎么做的、踩过的坑
- [docs/relay.md](docs/relay.md)：联网，中继的设计
- [docs/login.md](docs/login.md)、[docs/writing.md](docs/writing.md)：登录，写作
- [docs/serial.md](docs/serial.md)、[docs/usb.md](docs/usb.md)：串口、蓝牙，USB 设备
- [docs/files.md](docs/files.md)：文件进出
- [docs/workbench.md](docs/workbench.md)、[docs/warp.md](docs/warp.md)：封存的工作台和 WARP；[docs/network.md](docs/network.md)：没有采用的早期联网方案
