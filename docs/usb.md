# USB 设备（`usb`）

访客电脑上的 USB 设备，经 USB/IP 交给客户机：客户机的内核把它当成插在自己身上的设备来枚举，adb、fastboot、dfu-util 这些工具照常找到它，和在任何一台电脑上一样。

```
guest@zutto-issho ~> adb devices
  Pixel 8 (18d1:4ee7), on this computer's USB
List of devices attached
39101FDJH00ABC	device
guest@zutto-issho ~> usb
  1-1  Pixel 8 (18d1:4ee7)
  lsusb · usb off: let go of them, for this computer's own tools
```

工具用到设备时自己去借，浏览器只列出它用得上的那一类；`usb attach` 借任意一台，也可以按厂商或类别借：`usb attach 2e8a`、`usb attach fe/01`（十六进制，`厂商[:产品]` 或 `类别[/子类[/协议]]`）。同时最多三台，`usb` 看借着哪些，`usb off` 全部放开，好让这台电脑自己的工具用。

| 命令 | 借的设备 |
|---|---|
| `adb` | 打开了 USB 调试的安卓手机（接口 ff/42/01） |
| `fastboot` | bootloader 里的安卓手机（ff/42/03） |
| `dfu-util` | DFU 设备（类别 fe/01），比如 STM32 ROM 里的 bootloader |
| `rkdeveloptool` | 瑞芯微的芯片，Maskrom 或者它的 loader 里（2207） |
| `sunxi-fel` | 全志的芯片，FEL 模式（1f3a:efe8） |
| `picotool` | 树莓派的 RP2040、RP2350，BOOTSEL 里或者运行着（2e8a） |
| `mtk` | 联发科的芯片，boot ROM 或 preloader 里，mtkclient 认的那些 |
| `edl` | 高通的芯片，紧急下载模式（9008），edl 认的那些 |
| `openocd` | 调试器：DAPLink、树莓派的、ST-Link、J-Link、FTDI、乐鑫的、WCH-Link、NXP 的、Keil 的、Olimex 的 |
| `flashrom` | SPI flash 编程器：CH341A、CH347、FTDI、Dediprog、DirtyJTAG |
| `avrdude` | 它的 USB 编程器：USBasp、USBtinyISP、Atmel-ICE、PICkit 这些；串口的走 `serial`（[docs/serial.md](serial.md)） |

给了设备路径（`flashrom -p serprog:dev=/dev/ttyUSB0`）、只问帮助或者版本的，不去借（adb 的 keygen、kill-server、connect 这类也不借）。大多数在 `/etc/fish/conf.d/usb-tools.fish` 的一张表里，按厂商或类别写；adb、fastboot 各有自己的函数，avrdude 在 `serial-tools.fish`，它的编程器也可能接在串口上。表外的设备用 `usb attach`。

picotool 不在 Alpine 里，在 `image/tools/picotool/` 照它的 2.3.1 编译；mtkclient 和 edl 只在 GitHub 上，固定在各自的一次提交，和 esptool 一样装进 Python 那一层（`image/tools/python/`），依赖用 Alpine 的包。edl 的 loader（各家手机的 firehose 程序）在另一个仓库，有几百 MB，不随镜像：拖到页面上，用 `--loader` 指给它。

```
adb、fastboot、dfu-util ──usbfs──▶ 客户机的内核 ──vhci-hcd（USB/IP）──TCP──▶ socat（hostd 启动）
   ──▶ /dev/virtio-ports/virtio-1 到 -3 ──▶ 页面 src/usb/usbip.ts ──WebUSB──▶ 设备
```

## 怎么做的

**USB/IP**。Linux 自带的 USB/IP 让一台机器用另一台机器上的 USB 设备：设备那头跑 usbipd，用的那头的内核有一个虚拟的主控制器 vhci-hcd，两头之间是 TCP。这里的 usbipd 是页面：`usbip attach` 连上 127.0.0.1:3241（到 3243），hostd 用 socat 把这个连接接到 virtio 控制台的一个端口上，页面在另一头。连接交给内核之后，内核对设备的每个请求（URB）都顺着这条线到页面，页面用 WebUSB 对真设备照做，再把结果送回来。一个端口一台设备，所以同时三台。拔掉就是这条连接断开。

**WebUSB 管的几件事**。选配置、选接口的备用设置、清除端点的停止状态，WebUSB 有自己的调用，页面换成这些。接口在第一次用到时才认领；浏览器自己留着的类别（HID、大容量存储、音视频）认领不了，客户机收到的是 stall，和设备拒绝一个请求一样。其余请求原样转过去。WebUSB 不说设备跑在什么速度，页面按端点的包大小推断：批量端点 512 字节是高速，1024 是超高速，都不过 64 是全速，和标准给的上限一致。

**写先回答**。客户机写批量和中断端点时，页面收到就回答，再按顺序真的写出去；每个端点最多先答 1 MB，超出就等写完再答，客户机不会比设备快。先答了的写失败了，这个端点的下一次写收到那个错误，就像 USB 栈晚一步发现的错误。每个请求都要在模拟的机器里走一个来回，写若等着自己的回答，设备在两次写之间就闲着。

**放弃了的读**。libusb 的读超时了会放弃请求，WebUSB 却收不回已经发出去的读。它读回来的东西留给这个端点的下一次读，设备发来的不丢；客户机也不会再听到那个请求，vhci 若收到一个已经放弃了的请求的回答，会当成连接坏了。

**谁的设备**。devtmpfs 建的 USB 设备节点只有 root 能用。客户机的内核配置好设备时（它发的 SET_CONFIGURATION 经过页面），页面告诉 hostd，hostd 把节点交给访客，工具这才开始用。lsusb 按 udev 的硬件数据库给设备起名字，镜像里有一份只有 USB 的（`image/tools/hwdb/`）。

**回来的设备**。设备拔掉、重启又回来，还是原来那台（厂商、产品、序列号都一样）时，页面自己重新借给客户机，像插回同一个口。回来时成了另一台设备（手机从系统进 bootloader，DFU 设备 detach 之后），浏览器要访客再选一次：工具会再借，浏览器弹出列表（手机上先点一下屏幕上浮出的那枚键）。

**adb 的密钥**。每个浏览器一把 RSA 密钥，存在 IndexedDB 里（Tango 的凭据存储），名字是 `guest@<站点>`。第一次借安卓手机时，页面把它交给 hostd，写进 `~/.android/adbkey`；手机上勾过“始终允许”，刷新页面后也不用再确认。浏览器存不了时，adb 自己生成一把，只用这一次。

**原来的桥退了**。以前 adb 和 fastboot 不走 USB：客户机里的 adb 把手机当成网络上的设备，页面经 Tango 在 adb 的数据包和 USB 传输之间转换，fastboot 另有一层。换成 USB/IP 之前，在同一台假手机上比过（`npm run check:usb`）：

| 假手机上 | 原来的桥 | USB/IP |
|---|---|---|
| `adb shell cat`，4 MB，连同 md5sum | 1.67 秒 | 1.16 秒 |
| `adb push`，8 MB（adb 自己计的） | 0.31 秒 | 0.34 秒 |
| `fastboot stage`，16 MB | 0.25 秒 | 0.21 秒 |

不比原来慢，所有 USB 设备就走同一条路了。起初 USB/IP 推 8 MB 要 1.8 秒：socat 那一头的 TCP 没设 `nodelay`，内核等的每个小回答都被 Nagle 算法和延迟确认拖住，设上之后才是表里的数。

## 限制

- 只有 Chromium 系的浏览器有 WebUSB：电脑和 Android 上的 Chrome、Edge。
- Windows 上，设备要用 WinUSB 驱动，浏览器才拿得到它：安卓手机装 Google USB Driver；别的设备可以用 [Zadig](https://zadig.akeo.ie/) 换成 WinUSB，换了之后这台电脑上原来认它的工具可能就不认了。Linux 上要有权限打开设备节点（udev 规则），和用 libusb 的程序一样；macOS、Android 不用管。
- 电脑自己的程序正占着设备时（比如它自己的 adb server）借不到，要先在那边放开：`adb kill-server`。
- 浏览器自己留着的类别借不到：HID（键盘、鼠标，还有 CMSIS-DAP v1 这样走 HID 的调试器）、大容量存储（U 盘、读卡器）、音视频、智能卡、无线控制器（蓝牙适配器这类）。U 盘不能借来 `dd` 镜像：浏览器不给，电脑自己的驱动也正占着它；能用的路是开发板的下载协议（上面这些工具），或者用 `take` 把镜像存到电脑上，在那里烧（[docs/files.md](files.md)）。
- 联发科的 boot ROM 是个 CDC ACM 串口设备：Linux 上电脑自己的 `cdc_acm` 驱动会先占住它，Windows 上要换成 WinUSB。
- 不做等时传输。USB 复位传不到真设备，Linux 自己的 USB/IP 也是这样，复位只在客户机这一侧；靠复位进 bootloader 的工具，要设备自己 detach，DFU 设备大多会。

## 测试

`npm run check:usb` 给客户机插几台假设备，页面这一侧用的就是 `src/usb/` 本身，连浏览器保存的 adb 密钥也是（IndexedDB 由 fake-indexeddb 代替）。每台假设备都像真设备一样回答，连描述符都有，客户机的内核真的枚举它：

- 一台假手机，一个小 adbd：验 adb 的签名用的是浏览器保存的那把密钥；shell、4 MB 的读、8 MB 的 push；
- 重启进 bootloader：手机在客户机里也拔掉了，回来时是另一台设备，一个小 bootloader；fastboot 读变量、下载一个拖进来的 16 MB 文件；再拔掉插回，还是这台，自己借回来；
- 一台按 DFU 1.1 回答的设备，访客从只有 DFU 设备的列表里选它：dfu-util 下载，再上传回来，一字不差；
- 其余的工具都能跑，只问版本、帮助、有哪些编程器时，一台设备也不去借；
- `usb off`，三个口都放开。
