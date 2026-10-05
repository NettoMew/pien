# 串口（`serial`）

USB 转串口线插在访客的电脑上，客户机里就有一个真正的串口：

```
guest@zutto-issho ~> serial
  /dev/ttyUSB0  FTDI (0403:6001)
  tio -b 115200 /dev/ttyUSB0 · serial off
guest@zutto-issho ~> tio -b 1500000 /dev/ttyUSB0
```

两台机器上都有。第一次 `serial` 时浏览器弹出列表让访客选，选过的线之后直接用，拔了再插也会自动接回。终端用 [tio](https://github.com/tio/tio)，busybox 的 `microcom` 也在；python3 用标准库的 `termios` 也一样能用。

```
tio、stty、python3…… ──▶ /dev/ttyS2（Linux 自己的 8250 驱动）──▶ v86 模拟的 16550
   ──▶ 页面 src/serial/ ──Web Serial──▶ 电脑自己的驱动（FTDI、CP210x、CH34x、PL2303、CDC-ACM）──▶ 线
```

## 怎么做的

**客户机这一侧是一颗真的 UART**。v86 模拟 16550 串口芯片，第三个口（COM3）打开后就是客户机的 ttyS2。程序设串口的方式和在任何一台电脑上一样：termios 设速度、数据位、校验、停止位，ioctl 拉 DTR、RTS，发 break，读 CTS、DSR、DCD、RI。它们最后都落成芯片寄存器上的读写，页面从寄存器上把这些设置读出来，照样设到真的串口上。`/dev/ttyUSB0` 是接上线时 hostd 建的指向 ttyS2 的链接。

**速度**。16550 的速度是“时钟 ÷ 16 ÷ 一个整数分频”。客户机开机时用 `setserial` 把 ttyS2 的时钟设为 384 MHz（÷16 之后是 24 MHz），1500000（Rockchip 的调试串口）、2000000、3000000 都是整数分频，精确无误。115200、921600 这些分频之后差不到 0.2%，页面把它们对回本来的标准速度再交给 Web Serial，所以线上的速度也是精确的。

**设置一变就重开**。Web Serial 只能在打开串口时给定速度和帧格式。驱动每次改完设置，最后一步都是在关上分频锁存的情况下写一次线路控制寄存器；页面在这一刻比较新旧设置，变了就把真串口关掉、按新设置重新打开，在此之前没写完的字节先写完。DTR、RTS 和 break 一变就跟着变，所以 esptool 用 DTR、RTS 让 ESP32 复位进下载模式、Arduino 用 DTR 复位，都和在桌上一样。CTS、DSR、DCD、RI 每 100 毫秒看一次（Web Serial 没有这些线变化的事件），变了就反映到客户机读到的芯片状态里。

**驱动是电脑自己的**。Web Serial 走操作系统的串口驱动，FT232 在 Windows、macOS、Linux 上都有现成的驱动，页面不实现任何芯片的协议。

## 限制

只有电脑上的 Chrome 和 Edge 有 Web Serial。Android 上的 Chrome 从 148 版起才有，而且只支持蓝牙串口，USB 线还要等 Android 系统本身支持。

模拟的芯片一个字节一个字节地收发：假线上 64 KB 在 1500000 波特下往返要 1.2 秒，每个方向约 55 KB/s，比线速慢；115200 及以下比线还快。看日志、敲命令、刷固件都够用。

## 测试

`npm run check:serial` 给客户机插一根假的转串口线（按 USB ID 是 FTDI，输出接回输入），用客户机里的 stty、tio、python3 把整条路走一遍，页面这一侧用的就是 `src/serial/` 本身。
