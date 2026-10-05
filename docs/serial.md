# 串口（`serial`、`ble`）

访客电脑上的 USB 转串口线，或者配对过的蓝牙串口（HC-05 这一类），在客户机里都是一个真正的串口：

```
guest@zutto-issho ~> serial
  /dev/ttyUSB0  FTDI (0403:6001)
  tio -b 115200 /dev/ttyUSB0 · serial off
guest@zutto-issho ~> tio -b 1500000 /dev/ttyUSB0
```

蓝牙的叫 `/dev/rfcomm0`。两台机器上都有。第一次 `serial` 时浏览器弹出列表让访客选（手机上先点一下屏幕上浮出的那枚键），选过的之后直接用。线拔了再插、蓝牙设备走远了又回来，都会自动接回，客户机里开着的 tio 接着用。

## 工具

| 命令 | 用来 |
|---|---|
| `tio` | 终端；Ctrl-t x、Ctrl-t y 用 XMODEM、YMODEM 发文件 |
| `sz` `sx` `sb`，`rz` `rx` `rb` | [lrzsz](https://github.com/UweOhse/lrzsz)：ZMODEM、XMODEM、YMODEM 收发，配合 U-Boot 的 `loadx`、`loady` |
| `esptool`、`espefuse`、`espsecure` | 乐鑫的芯片，ESP8266 和各型号 ESP32 |
| `mpremote` | MicroPython 板子的 REPL 和文件 |
| `stm32flash` | STM32，经芯片 ROM 里的串口 bootloader |
| `avrdude` | AVR：Arduino 的 bootloader（`-c arduino`、`-c urclock`），STK500 这类串口编程器；USB 的编程器借的是 USB 设备（[docs/usb.md](usb.md)） |

这些工具不用先敲 `serial`，也不用写串口在哪：还没借到串口时它们先借一个，再按各自的方式告诉它。tio 和 stm32flash 加在命令最后，avrdude 加 `-P`，esptool 经 `ESPTOOL_PORT`，mpremote 在前面加 `connect`，lrzsz 把标准输入输出接上去。自己指定了串口，或者这一次用不着串口（`esptool merge-bin`、`mpremote version`），就原样运行。都在 `/etc/fish/conf.d/serial-tools.fish`。

往 U-Boot 传文件，在 tio 里敲 `loady 0x82000000`，再 Ctrl-t y 选文件；或者退出 tio（Ctrl-t q），U-Boot 还在等，`sb u-boot.itb` 就传过去了。

lrzsz 不在 Alpine 里，esptool 和 mpremote 在 PyPI 上。它们各有一份固定版本的构建（`image/tools/`，`npm run build:tools`）：lrzsz 用 2026 年 10 月的 0.13.1，几十年来第一个新版，修了收发两头的老溢出；Python 那一层只装这几个包本身，按哈希核对，依赖全用 Alpine 的包，字节码在构建时编好，客户机里不用再编。

```
tio、stty、esptool…… ──▶ /dev/ttyS2（Linux 自己的 8250 驱动）──▶ v86 模拟的 16550
   ──▶ 页面 src/serial/ ──Web Serial──▶ 电脑自己的驱动（FTDI、CP210x、CH34x、PL2303、CDC-ACM）──▶ 线
                                    └─▶ 蓝牙（RFCOMM）──▶ HC-05 这类模块
```

## 怎么做的

**客户机这一侧是一颗真的 UART**。v86 模拟 16550 串口芯片，第三个口（COM3）打开后就是客户机的 ttyS2。程序设串口的方式和在任何一台电脑上一样：termios 设速度、数据位、校验、停止位，ioctl 拉 DTR、RTS，发 break，读 CTS、DSR、DCD、RI。它们最后都落成芯片寄存器上的读写，页面从寄存器上把这些设置读出来，照样设到真的串口上。`/dev/ttyUSB0`、`/dev/rfcomm0` 是接上时 hostd 建的指向 ttyS2 的链接；串口断开再接回，ttyS2 一直在，开着它的程序察觉不到。

**速度**。16550 的速度是“时钟 ÷ 16 ÷ 一个整数分频”。客户机开机时用 `setserial` 把 ttyS2 的时钟设为 384 MHz（÷16 之后是 24 MHz），1500000（Rockchip 的调试串口）、2000000、3000000 都是整数分频，精确无误。115200、921600 这些分频之后差不到 0.2%，页面把它们对回本来的标准速度再交给 Web Serial，所以线上的速度也是精确的。

**设置一变就重开**。Web Serial 只能在打开串口时给定速度和帧格式。驱动每次改完设置，最后一步都是在关上分频锁存的情况下写一次线路控制寄存器；页面在这一刻比较新旧设置，变了就把真串口关掉、按新设置重新打开，在此之前没写完的字节先写完。CTS、DSR、DCD、RI 每 100 毫秒看一次（Web Serial 没有这些线变化的事件），变了就反映到客户机读到的芯片状态里。

**DTR 和 RTS 一起变**。esptool 让 ESP32 复位进下载模式、stm32flash 让板子进 bootloader，靠的是 DTR、RTS 按顺序变；常见的自动复位电路是两个三极管交叉接，两条线同时变和先后变，结果不一样。客户机一次写下两条线（`TIOCMSET`）是对调制解调器控制寄存器的一次写，v86 在这一次写里先后报出两条线的变化；页面在第一条报出时就从寄存器读两条线，一次 `setSignals` 一起设，第二条报出时已经没有新东西。前后的字节也按原来的顺序走。

**蓝牙**。Web Serial 把配对过的、带标准串口服务（SPP）的蓝牙设备和 USB 线列在一起；服务是自己定的 UUID 的，用 `serial --uuid <UUID>` 去要。RFCOMM 上只有字节：速度和帧格式是蓝牙模块自己的设置（HC-05 用 AT 命令设），也没有 DTR、RTS 这些线，客户机怎么设都由它，页面不重开、不传。设备走远或者重启，蓝牙不像 USB 那样有“插回来”的事件，页面每 3 秒试着重新打开一次，两分钟为止。

**没人开着就丢**。串口没有程序开着时收到的字节就丢掉，和真的 16550 一样：驱动打开串口时拉高 OUT2（PC 上它决定芯片的中断能不能送到），关掉时拉低，页面看着这一位。v86 原本会把这些字节全攒着，攒多少都行，留给下一个打开串口的程序。

**驱动是电脑自己的**。Web Serial 走操作系统的串口驱动，FT232、CP210x、CH340 在 Windows、macOS、Linux 上都有现成的驱动，页面不实现任何芯片的协议。

## 蓝牙 LE（`ble`）

BLE 没有标准的串口，模块各自定一个 GATT 服务：一个特征推送设备发来的字节，另一个特征用来写。`ble` 经 Web Bluetooth 连上这样的设备，客户机里就多一个 `/dev/ttyBLE0`：

```
guest@zutto-issho ~> ble
  /dev/ttyBLE0  HMSoft (HM-10)
  tio /dev/ttyBLE0 · ble off
guest@zutto-issho ~> mpremote connect /dev/ttyBLE0
```

认得的服务：

| 服务 | 设备 |
|---|---|
| Nordic UART（NUS） | nRF 系列、Zephyr、ESP32 的例子、MicroPython 的蓝牙 REPL、Adafruit Bluefruit |
| FFE0（读写都是 FFE1） | HM-10，和同样用 TI CC2541 的 HC-08、JDY-08、BT05、AT-09 |
| FFF0（FFF1 读，FFF2 写） | 沁恒的 CH9141、CH9143 |
| Transparent UART | Microchip 的 RN4870、BM70 |
| VSP | Ezurio（原 Laird）的 BL65x |
| SPS | u-blox 的 NINA-B、ANNA-B，不用 credits |

别的设备用 `ble --uuid <服务的 UUID>`，服务里能推送的特征当读、能写的当写。后四种照厂商的资料和例子写成，还没在真的模块上试过。

选设备的列表里是浏览器听得到的所有 BLE 设备：很多设备连上之前不说自己有哪些服务，按服务筛会漏掉它们。选过的设备这次访问里一直用，`ble off` 才忘掉，下次重新选；选的设备没有串口服务，也忘掉。设备走远或者重启，页面每 3 秒试着重连一次，两分钟为止，开着 `/dev/ttyBLE0` 的程序接着用。

**怎么做的**。v86 再模拟一颗 16550，客户机的 ttyS3，`/dev/ttyBLE0` 指向它。线上只有字节：速度和帧格式是模块那头 UART 自己的设置，也没有 DTR、RTS。客户机写出的字节切成 20 字节一段：BLE 最小的 MTU 是 23，减去 3 字节的头；Web Bluetooth 不告诉实际谈好的 MTU，20 是哪里都放得下的大小。特征允许时不等回复就写下一段。设备的名字是它自己报的，附近谁都能起任何名字，页面去掉控制字符再交给客户机，hostd 也整个当作一段文字，不拆不展开。

内核探测 COM4 时要做一次回环测试，COM1 到 COM3 都跳过。v86 的 UART 回环时只回字节、不回信号线，测试不过，内核就不认这个口；`/etc/rc` 用 `setserial` 直接告诉它这是一颗 16550A。

## 限制

电脑上的 Chrome 和 Edge 有 Web Serial，USB 线和蓝牙都行。Android 上的 Chrome 也有，但只有蓝牙：手机上用 HC-05 这类模块正好。Firefox 和 Safari 没有。Web Bluetooth 也是一样：电脑和 Android 上的 Chrome、Edge 有，Firefox、Safari 没有。

蓝牙上没有 DTR、RTS，esptool 和 Arduino 的自动复位做不到，要手按板子上的键进 bootloader。

模拟的芯片一个字节一个字节地收发：假线上 64 KB 在 1500000 波特下往返要 1.4 秒，每个方向约 47 KB/s，比线速慢；115200 及以下比线还快。看日志、敲命令、刷固件都够用。Python 写的工具启动要几秒（`esptool version` 4.4 秒，`mpremote version` 2.2 秒），都是模拟的 CPU 在算。

## 测试

`npm run check:serial` 给客户机插几根假的线，页面这一侧用的就是 `src/serial/` 本身：

- 一根转串口线，按 USB ID 是 FTDI，输出接回输入：用 stty、tio、python3 把速度、帧格式、数据、各条信号线走一遍，一起设的 DTR、RTS 一起到，没人开着时回来的字节不留；
- 一块停在 U-Boot `loady` 的板子：一个 YMODEM 接收端，和 U-Boot 一样先发 `C`、按 CRC 核对每一块。`sb` 自己借到串口，把 50 KB 传过去，一字不差；
- esptool 和 mpremote 能跑，用不着串口时不去借；
- 一个配对过的蓝牙设备：设置和信号线都不传，字节照常走；走远了再回来会自动接回，一直开着它的程序接着写；`--uuid` 要到的是自己定服务的那一个。

`npm run check:ble` 只假装 Web Bluetooth：几台把收到的字节原样发回来的设备，和浏览器里一样，只列出选它时允许的服务。

- 一台 Nordic UART 设备：从所有设备里选出来，服务认出来；8 KB 往返一字不差，每次写都不超过 20 字节；走远了再回来自动接回，一直开着它的程序接着写；
- 一台 HM-10：一个特征两头用；
- 一台服务是自己定的：`--uuid` 要到，三个特征里只能读的那个不用，按允许的操作分出读和写；
- 一台没有串口服务的手表：说清楚，断开，下一次 `ble` 重新选。
