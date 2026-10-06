# 中继（`net on`）

访客在终端里敲 `net on`，这台虚拟机就有了网：IPv4 是一段私有网段，IPv6 是这次会话自己的一个地址，中继配了公网前缀时就是公网地址，经中继出门：`ip a`、`curl`、`git`、真实的 `ping`、DNS 都能用。本站的中继只给站长用：先登录（[login.md](login.md)）。谁都可以搭一个自己的中继，用 `net relay <地址>` 指过去。

```
v86 eth0 ──帧──▶ 页面（src/net/relay.ts）══WebSocket，内层加密══▶ Caddy ──▶ nginx ──▶ relay（relay/）──▶ 互联网
                                                                            每条连接一段自己的网：
                                                                            10.0.2.15 访客 · 10.0.2.2 网关 · 10.0.2.3 DNS
                                                                            访客的 IPv6：会话自己的 /128，DHCPv6 发
                                                                            fdca:c697:4c23::2 网关，在 fe80::2 发通告
```

（另一条路 Cloudflare WARP 已封存，见 [warp.md](warp.md)。）

## 中继：`relay/`

一个 Rust 静态二进制，Docker 镜像 7.9 MB。每条 WebSocket 就是一段独立的虚拟网段，和 QEMU 的 user 网络（slirp）一样：

| | |
|---|---|
| 线路格式 | 一条二进制消息就是一个以太网帧，和 v86 的 wsproxy 一样，只是外面多一层加密 |
| 链路层 | 归会话自己：链路上只有访客一个，发给它的包都发到它的 MAC。ARP 替访客之外的每个地址回（10.0.2.2、10.0.2.3，还有别名放在这段里的）；邻居请求只替网关自己的两个 IPv6 地址回，而且以路由器的身份回（R 位：不这样回，Linux 就当它不再是路由器，把经它的默认路由删掉）。网关 MAC 用 QEMU 的 `52:55:0a:00:02:02`。smoltcp 只管 IP 层 |
| IPv6 | 每个会话一个自己的地址：一个 /128，随机取，由 DHCPv6 发给访客（`addresses.rs`、`dhcp.rs`）。网关从 `fe80::2` 发路由通告，M 位叫访客去 DHCPv6 要地址，不带前缀（链路上没有可以自己生成地址的网段）；会话开始时、之后每 10 分钟、访客来要时各发一次。中继配了公网前缀（`egress.ipv6`）时，地址从里面取，会话的 IPv6 也**从这个地址出门**，外面看到的就是访客自己的地址，目标两个族都有时访客先用 IPv6（[见下](#公网-ipv6)）；没配时，从中继自己的唯一本地前缀 `fdca:c697:4c23::/64` 取（RFC 4193，全局 ID 随机抽过一次就写死），出门用宿主机的地址，按 RFC 6724，目标两个族都有时访客先用 IPv4。下面各行的做法两个族一样。DNS 仍是 10.0.2.3，AAAA 记录照常返回 |
| TCP | smoltcp 扮演网关一端。**先真的连上目标，再回访客的 SYN**：对方拒绝就回 RST（curl 报 Connection refused），连不上就回 ICMP 主机不可达，和真实网络一样 |
| UDP | 绕过 smoltcp：每个（访客端口，目的地）一个真实的 UDP socket，闲置 60 秒回收；对方端口关着时，访客收到 ICMP「端口不可达」 |
| ICMP | ping 走 Linux 的非特权 ping socket（`ping_group_range`，ICMPv6 也归它管；容器里默认对所有组开放）；回给访客的 echo reply 由中继构造 |
| TTL（traceroute、mtr） | 中继按路由器的规矩处理访客的 TTL（IPv6 叫跳数限制）：用尽的包由网关回「超时」（第 1 跳）；其余按剩下的 TTL 发到真实网络，沿途路由器回的「超时」「不可达」「包太大」经 Linux 的 `IP_RECVERR`、`IPV6_RECVERR` 错误队列收下，原样转给访客，引用访客自己的原始包（IPv4 引用包头和其后 8 字节，IPv6 引用到整个错误包不超过 1280 字节为止），所以 mtr 和 traceroute 认得出自己的探测。ping 和 UDP 两种探测都支持 |
| DNS | 发往 10.0.2.3:53 的查询由中继解析；上游默认走 DoT（Cloudflare），也可以配 Quad9、Google、系统解析或某个地址；可以配静态 hosts（IPv4 地址回 A 记录，IPv6 地址回 AAAA） |
| 策略 | 默认只放行公网：IPv4 的私网、回环、链路本地、CGNAT、文档段、组播、保留地址都拦下；IPv6 只放行全球单播 2000::/3，其中的文档段、2001::/23（IETF 协议用途，Teredo 在内）、6to4（2002::/16，里面能藏任何 IPv4 地址）也拦下。拦下时回 ICMP「被禁止」。检查的是**真正要连的地址**，所以 DNS 指向内网也没用。访客只能用自己的地址发包：10.0.2.15，和发给它的那个 IPv6 地址。端口白名单、黑名单（默认拦 25）、别名（把某个访客地址映射到真实地址，不受检查；两个族都行，也可以跨族，这时网络回的错误报告访客收不到） |
| 出口 | TCP 直连，或者经 SOCKS5（比如本机的 Mayami）：代理说拒绝，访客照样收到 RST；UDP 和 ICMP 直连 |
| 限额 | 会话数（默认 4）、每会话 TCP 连接数（256）、每会话限速（两个方向各一个令牌桶，带一秒的突发）、每会话流量额度、闲置超时（30 分钟）。额度用完以关闭码 4001 结束，闲置以 4002 结束，访客看到对应的说明（`net.fish` 的 `__net_why`） |
| 记录 | 只有计数：会话数、拒绝次数、上下行字节、连接数。**不记录任何目的地址** |

### 公网 IPv6

服务器分到一段 /64 时，每个会话可以从里面拿一个自己的公网地址：`relay.toml` 里

```toml
[egress]
ipv6 = "2001:db8:1:2:1::/80"    # 那段 /64 里的一段，宿主机自己的地址不在里面
uplink = "eth0"                 # 上游在这块网卡上问这些地址在哪
```

会话开始时从这段里随机取一个 /128（同时在用的不会重），会话结束就还回去，下次是另一个。要三样东西配合：

- **宿主机把整段当成自己的**：`ip -6 route add local 2001:db8:1:2:1::/80 dev lo`（AnyIP），开机时加上（[deploy.md](deploy.md#公网-ipv6)）。哪块网卡上都没有这些地址，中继的 socket 照样能绑到上面（`IPV6_FREEBIND`），回来的包内核当成本机的收下，交给绑着它的 socket。
- **中继在宿主机的网络里**：容器自己的网络命名空间里，内核收不到发给这段地址的包。Docker 用 `--network host`；不用 Docker 本来就是。
- **上游问的时候有人答**。有的上游把 /64 路由到服务器，什么都不问，`uplink` 不用配。多数 VPS 的上游把 /64 当成链路上的：给每个地址发包前，先在链路上发邻居请求问它在哪，没人答就不发。这时中继在 `uplink` 那块网卡上替**正在用的**地址回（`uplink.rs`）：一个 packet socket，内核只把邻居请求交给它，按在用的地址加入各自的 solicited-node 组播组。上游属于哪种，看一眼就知道：从外面 ping 这段里一个没人用的地址，同时在服务器上抓包，看得到上游路由器发来 `who has` 那个地址的邻居请求，就是后一种。

开这个 packet socket 要 `CAP_NET_RAW`，中继唯一要用到的特权。它在还只有一个线程时先开好 socket，然后放弃所有 capability（Linux 的 capability 是按线程算的，之后起来的线程都没有）；镜像里的程序带着文件 capability `cap_net_raw=p`，只是允许、不是生效，用的时候中继自己生效、用完就扔；不用 Docker 时由 systemd 给（`AmbientCapabilities`）。没给它，中继启动时就说 `egress.uplink eth0: it takes CAP_NET_RAW`。

外面 ping 一个在用的地址，回的是宿主机的内核（地址是它的）；主动连进访客还不行，中继只替访客往外连。会话结束后，中继不再替那个地址回答，上游过一会儿就找不到它了。

这些都是 Linux 的：配了 `egress.ipv6` 的中继在别的系统上不启动。

### 内层加密（`relay/src/channel.rs`）

为了让前面的 TLS 终结者（Caddy）和它的日志看不到帧，WebSocket 里面再套一层：

```
页面 → 中继   "GHR1" ‖ 页面随机数(16) ‖ 页面 P-256 临时公钥(65)
          或   "GHR2" ‖ 页面随机数(16) ‖ 页面 P-256 临时公钥(65) ‖ 登录的 token(57)
中继 → 页面   中继随机数(16) ‖ 中继 P-256 临时公钥(65)
密钥          HKDF-SHA256(ikm = 密钥 ‖ ECDH, salt = 两个随机数, info = "guest@home relay v1")
              → 页面→中继、中继→页面各一把 AES-256-GCM 密钥
之后          每条消息 AES-256-GCM，nonce = 4 个零字节 ‖ 64 位计数器
              页面先发 "hello"，中继回 "welcome"，然后一条消息一个以太网帧
```

- 密钥有两种，中继配哪种就认哪种（也可以两种都配）：
  - **本站中继认登录**（`session_key`，GHR2）：页面把登录的 token 附在 hello 后面，中继用会话密钥自己验它、自己算出通道密钥（见 [login.md](login.md)），不问 press，也没有登录列表。
  - **自己的中继认自己的密钥**（`key`，GHR1）：`relay key` 打印 32 个随机字节；在页面里 `net relay <地址>` 时粘贴一次，按地址记在浏览器里。
- 两种情况下密钥本身都不上线。
- 临时 ECDH 提供前向保密；两边的随机数让旧消息无法重放，计数器保证顺序。
- 密钥或登录不对，中继在一秒后以 1008 关闭：本站中继的访客看到「The relay did not take this login: net login again.」；自己的中继，页面忘掉那把密钥，下次 `net relay <地址>` 时再问。
- 页面那边全部用 WebCrypto 实现，不需要 wasm。

### 配置

全部可选，只有密钥必填，见 `relay/src/config.rs` 开头：

```toml
listen = "127.0.0.1:8095"
key = "…"                       # 这个中继自己的密钥：relay key
session_key = "…"               # 或者本站的会话密钥：认站长的登录

[dns]
upstream = "cloudflare-tls"     # quad9-tls、google-tls、system，或一个地址
hosts = { "nas.home" = "192.168.1.10", "printer.home" = "fd00::20" }

[egress]
socks5 = "127.0.0.1:7890"       # TCP 经 SOCKS5；默认直连
udp = true
ipv6 = "2001:db8:1:2:1::/80"    # 每个会话一个自己的公网地址，从这里取；默认没有，用私有的
uplink = "eth0"                 # 上游在这里问它们在哪；默认不问，上游把前缀路由过来

[policy]
allow_private = false
allow_ports = []                # 空：所有端口
deny_ports = [25]
aliases = { "10.0.2.4" = "192.168.1.10" }   # IPv6 地址也行

[limits]
sessions = 4
flows = 256
rate = 0                        # 每秒字节数，每个方向；0：不限
quota = 0                       # 每会话字节数；0：不限
idle = 1800                     # 秒
```

## 页面：`src/net/`

- `index.ts`（常驻）：`net on`、`net off` 依次排队处理。
- `answers.ts`（用到时才加载）：客户机的提问（`src/ask.ts`）：登录、通行密钥、GitHub、选哪个中继。
- `relays.ts`：走哪个中继：本站的，或者访客自己的（地址和密钥）。
- `relay.ts`（用到时才加载）：握手（带登录或自己的密钥）、逐帧加解密（保证顺序）、页面从后台回来时自动重连。连没连上，客户机里的 `net` 会说。中继在握手中途挂断（密钥不对）时，等回复的那一步也随之结束，后面的 `net` 命令不会被卡住。
- 中继地址：构建时用 `VITE_RELAY_URL` 指定，默认是同源的 `<base>relay`。

## 客户机

- `net on` 时，hostd 收到 `net up relay 10.0.2.15/24 10.0.2.2 10.0.2.3 1500`，配好 eth0、路由和 `/etc/resolv.conf`；没联网时 eth0 没有地址，程序会立刻报 Network unreachable，不会卡住。
- IPv6 不用页面传话：hostd 先把 eth0 关掉再打开，内核听到网关的通告，装上经它的默认路由；`udhcpc6` 去要地址，`/usr/libexec/home/dhcp6` 把它装成 /128，试三次、一秒一次，要不到就算了。上一个中继给的地址随网卡关掉一并清掉。只发 SLAAC 通告的旧中继，内核照样自己生成地址。
- 所有访客从同一个快照起来，网卡的 MAC 都一样，照 SLAAC 生成的地址也会一样：所以地址由中继发，每个会话各一个。
- busybox 的 DHCP 客户端在还没有地址时用 packet socket 收发，内核为此开了 `CONFIG_PACKET`（bzImage 多 12 KB）。`/etc/rc` 关了 eth0 上的重复地址检测（这条链路上只有访客和网关），地址拿到就能用。
- `net on` 和 `net` 把两个地址都列出来；`net on` 等 IPv6 地址最多三秒。
- `net on` 走本站中继却没登录时，先跑一遍 `net login`，登录完自动重试。
- `net relay <地址>` 换成自己的中继，第一次会问它的密钥（`read -s`，手机上有粘贴键）；`net relay reset` 换回本站的。
- 访客用户的 PATH 加了 `/sbin`，`ip a`、`ip route` 直接能敲。
- 失败时说明原因：没登录、登录不被认、自己的中继缺密钥或密钥不对、中继正忙、连不上中继、连接断了……

## 实测

2026-10-06 晚上，公网 IPv6，在现在的服务器（香港）上：和线上同一个镜像临时起了一个带自己密钥的中继，配上那台机器 /64 里的一段 /80 和 `uplink = "eth0"`，本机经它起一个会话，验完即删：

| | |
|---|---|
| 地址 | 会话拿到那段 /80 里的一个 /128 |
| 外面看到的 | 一个回显来访地址的服务（icanhazip，经 IPv6）看到的就是这个地址 |
| 从外面找它 | 会话在的时候，东京那台机器 ping 这个地址 4/4，50 ms：上游路由器问，中继答了 |
| 特权 | 中继以 65534 运行，开好 packet socket 之后，81 个线程的 capability 全是 0 |

同一天白天，在当时的线上服务器（东京）上，私有 IPv6（那时访客自己用 SLAAC 生成地址）：

| | |
|---|---|
| `net on` | 2.3 秒，含问 Cloudflare 出口在哪；第一行就列出 IPv4、IPv6 两个地址 |
| `ping -6 2606:4700:4700::1111` | 平均 76 ms（本机在香港，当时的中继在东京） |
| `curl -6` | 出口是那台机器自己的 IPv6 地址，Cloudflare 的机房是 NRT；`ipv6.google.com` 200；两个族都有的 `www.google.com` 走 IPv4（RFC 6724） |
| `mtr -6` | 七跳都在：网关 `fdca:c697:4c23::2`、Docker 网桥、DMIT 的两台路由器、JPIX、Cloudflare、目的地 |
| 访问 `fd00::1` | 1.6 秒内被拦下 |

2026-10-05 在香港量的，握手之后的部分至今没变：`ping 1.1.1.1` 平均 38 ms；`curl https://github.com/` 200，DNS 0.05 s，TLS 0.61 s；客户机里下载 2.0 MB/s，瓶颈是模拟的 CPU（中继本身 release 构建 150 MiB/s）；访问 10.0.0.1，40 ms 内被拦下。

## 测试

- `cargo test --manifest-path relay/Cargo.toml`（CI 在跑）：
  - 单元测试：两个族的报文构造（校验和、各族自己的 ICMP 类型和代码、IPv6 错误报文引用到 1280 字节为止、路由通告），ARP 和邻居发现（应答、路由器的 R 位、上游的邻居请求和 solicited-node 组），DHCPv6（请求和回复、快速提交、续租、确认、释放、该不答的不答），地址池（每个会话各一个、还回去），加密通道（错误密钥、重放、乱序），配置、前缀、策略；
  - 端到端（21 项）：smoltcp 扮演一台有以太网、ARP 和邻居发现的访客，像 udhcpc6 一样用 DHCPv6 要到 IPv6 地址，经真实的 WebSocket 和加密通道连进进程内的中继，再经别名访问本机的测试服务（192.0.2.10 → 127.0.0.1，2001:db8::10 → ::1）。两个族各测一遍：TCP 双向和半关闭、被拒（SYN-SENT 时就收到 RST）和被策略拦下（ICMP）、UDP、UDP 端口不可达、第一个包就 ping 得通网关、最后一跳在网关；另有两个一模一样的访客各拿到自己的地址、网关以路由器的身份答邻居请求、DNS 的 A 和 AAAA、错误密钥被拒、登录、经 SOCKS5 出口（连通和被拒）、限速、额度、闲置；
  - Linux 上两个族各多一项 `ping_goes_out`：经 ping socket 真的发出去；另有两项默认跳过（`--ignored`）：`a_public_address_is_the_way_out`，配了公网前缀的会话连本机的服务，对方看到的正是会话的地址，要先加一条 AnyIP 路由（`ip -6 route add local 2001:db8:5::/64 dev lo`，CI 加了，也跑它）；`the_next_hop_is_out_there`，要外网，TTL 2 到 4 的 ping 从真实路由器收到「超时」。
- `npm run check:login` 里，真的客户机联网后用 udhcpc6 拿到一个 /128、默认路由经 `fe80::2`，第一个 ping 就通网关，经中继的别名用 IPv6 连到本机的 press，之后默认路由还在。

## 本地开发

```sh
cd relay && cargo run -- key            # 打印一把随机密钥
cat > relay.toml <<EOF
key = "…"                               # 页面里 net relay ws://127.0.0.1:8095/ 时粘贴它
EOF
cargo run -- relay.toml                 # 监听 127.0.0.1:8095；Windows 上没有 ping
npm run dev                             # /relay 代理到 127.0.0.1:8095（RELAY=host:port 可改）
```

要测 ping，就把中继跑在一台 Linux 的容器里，再用 SSH 转发；容器里用的 relay.toml 要加一行 `listen = "0.0.0.0:8095"`，默认的 127.0.0.1 在容器里，外面连不进来：

```sh
docker build -t homepage-relay relay/   # 在那台机器上
docker run -d -p 127.0.0.1:8095:8095 -v ./relay.toml:/etc/relay.toml:ro homepage-relay
ssh -N -L 127.0.0.1:18095:127.0.0.1:8095 <那台机器> &
RELAY=127.0.0.1:18095 npm run dev
```

## 部署

用 Docker、不用 Docker、公网 IPv6、本站现在的样子，都在 [deploy.md](deploy.md)。中继在其中只是一个静态程序：配置见 `deploy/relay.toml.example`，不用 Docker 时的 systemd 服务见 `deploy/systemd/pien-relay.service`。
