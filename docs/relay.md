# 中继（`net on`）

访客在终端里敲 `net on`，这台虚拟机就拿到一段私有的网络，IPv4 和 IPv6 都有，经中继出门：`ip a`、`curl`、`git`、真实的 `ping`、DNS 都能用。本站的中继只给站长用：先登录（[login.md](login.md)）。谁都可以搭一个自己的中继，用 `net relay <地址>` 指过去。

```
v86 eth0 ──帧──▶ 页面（src/net/relay.ts）══WebSocket，内层加密══▶ Caddy ──▶ relay（relay/）──▶ 互联网
                                                                  每条连接一段私有网段：
                                                                  10.0.2.15 访客 · 10.0.2.2 网关 · 10.0.2.3 DNS
                                                                  fdca:c697:4c23::/64 访客自己生成地址 · ::2 网关
```

（另一条路 Cloudflare WARP 已封存，见 [warp.md](warp.md)。）

## 中继：`relay/`

一个 Rust 静态二进制，Docker 镜像 5.3 MB。每条 WebSocket 就是一段独立的虚拟网段，和 QEMU 的 user 网络（slirp）一样：

| | |
|---|---|
| 线路格式 | 一条二进制消息就是一个以太网帧，和 v86 的 wsproxy 一样，只是外面多一层加密 |
| L2 | smoltcp 回 ARP 和邻居请求，学访客的 MAC；网关 MAC 用 QEMU 的 `52:55:0a:00:02:02` |
| IPv6 | 和 IPv4 并排的第二段网：唯一本地前缀 `fdca:c697:4c23::/64`（RFC 4193，全局 ID 随机抽过一次就写死，和 10.0.2.0/24 一样每个会话都相同）。网关从 `fe80::2` 发路由通告：会话开始时、之后每 10 分钟、访客来要时；访客照 SLAAC 用自己的 MAC 生成地址，默认路由指向网关。下面各行的做法两个族一样，IPv6 的包出门也走 IPv6。DNS 仍是 10.0.2.3，AAAA 记录照常返回。源地址是私有前缀，按 RFC 6724 的默认规则，目标两个族都有时访客先用 IPv4；只有 IPv6 的目标，或者 `curl -6` 这样指定，才走 IPv6 |
| TCP | smoltcp 扮演网关一端。**先真的连上目标，再回访客的 SYN**：对方拒绝就回 RST（curl 报 Connection refused），连不上就回 ICMP 主机不可达，和真实网络一样 |
| UDP | 绕过 smoltcp：每个（访客端口，目的地）一个真实的 UDP socket，闲置 60 秒回收；对方端口关着时，访客收到 ICMP「端口不可达」 |
| ICMP | ping 走 Linux 的非特权 ping socket（`ping_group_range`，ICMPv6 也归它管；容器里默认对所有组开放）；回给访客的 echo reply 由中继构造 |
| TTL（traceroute、mtr） | 中继按路由器的规矩处理访客的 TTL（IPv6 叫跳数限制）：用尽的包由网关回「超时」（第 1 跳）；其余按剩下的 TTL 发到真实网络，沿途路由器回的「超时」「不可达」「包太大」经 Linux 的 `IP_RECVERR`、`IPV6_RECVERR` 错误队列收下，原样转给访客，引用访客自己的原始包（IPv4 引用包头和其后 8 字节，IPv6 引用到整个错误包不超过 1280 字节为止），所以 mtr 和 traceroute 认得出自己的探测。ping 和 UDP 两种探测都支持 |
| DNS | 发往 10.0.2.3:53 的查询由中继解析；上游默认走 DoT（Cloudflare），也可以配 Quad9、Google、系统解析或某个地址；可以配静态 hosts（IPv4 地址回 A 记录，IPv6 地址回 AAAA） |
| 策略 | 默认只放行公网：IPv4 的私网、回环、链路本地、CGNAT、文档段、组播、保留地址都拦下；IPv6 只放行全球单播 2000::/3，其中的文档段、2001::/23（IETF 协议用途，Teredo 在内）、6to4（2002::/16，里面能藏任何 IPv4 地址）也拦下。拦下时回 ICMP「被禁止」。检查的是**真正要连的地址**，所以 DNS 指向内网也没用。端口白名单、黑名单（默认拦 25）、别名（把某个访客地址映射到真实地址，不受检查；两个族都行，也可以跨族，这时网络回的错误报告访客收不到） |
| 出口 | TCP 直连，或者经 SOCKS5（比如本机的 Mayami）：代理说拒绝，访客照样收到 RST；UDP 和 ICMP 直连 |
| 限额 | 会话数（默认 4）、每会话 TCP 连接数（256）、每会话限速（两个方向各一个令牌桶，带一秒的突发）、每会话流量额度、闲置超时（30 分钟）。额度用完以关闭码 4001 结束，闲置以 4002 结束，访客看到对应的说明（`net.fish` 的 `__net_why`） |
| 记录 | 只有计数：会话数、拒绝次数、上下行字节、连接数。**不记录任何目的地址** |

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
- IPv6 不用页面传话：hostd 先把 eth0 关掉再打开，内核一起来就向网关要路由通告，照着生成地址、装上默认路由；换到不发通告的中继时，上一个中继给的地址也随网卡关掉一并清掉。`/etc/rc` 关了 eth0 上的重复地址检测（这条链路上只有访客和网关），地址立刻能用，省掉每次联网一秒的等待。内核因此多了 IPv6，bzImage 大了 160 KB。`net on` 和 `net` 把两个地址都列出来。
- `net on` 走本站中继却没登录时，先跑一遍 `net login`，登录完自动重试。
- `net relay <地址>` 换成自己的中继，第一次会问它的密钥（`read -s`，手机上有粘贴键）；`net relay reset` 换回本站的。
- 访客用户的 PATH 加了 `/sbin`，`ip a`、`ip route` 直接能敲。
- 失败时说明原因：没登录、登录不被认、自己的中继缺密钥或密钥不对、中继正忙、连不上中继、连接断了……

## 实测（2026-10-05，还用口令的时候；握手之后的一切没变。本机浏览器 → SSH 转发 → v2in0 上的中继容器，香港）

| | |
|---|---|
| 第一次 `net on`（输入口令、派生密钥、握手、配网卡） | 3.8 秒 |
| 再次 `net on` | 0.7 秒 |
| `ping -c 3 1.1.1.1` | 3/3，平均 38 ms |
| `curl https://github.com/` | 200；DNS 0.05 s，TLS 0.61 s |
| 下载 5 MB | 2.0 MB/s（瓶颈是模拟的 CPU；中继本身 release 构建 150 MiB/s） |
| 访问 10.0.0.1 | 40 ms 内被拦下（ICMP） |
| 口令错误 | 「中继不认这个口令：net login 重新输入。」 |

## 测试

- `cargo test --manifest-path relay/Cargo.toml`（CI 在跑）：
  - 单元测试：两个族的报文构造（校验和、各族自己的 ICMP 类型和代码、IPv6 错误报文引用到 1280 字节为止、路由通告）、加密通道（错误密钥、重放、乱序）、配置、策略；
  - 端到端（20 项）：smoltcp 扮演一台有以太网、ARP 和邻居发现的访客，像 Linux 一样从网关的通告生成 IPv6 地址，经真实的 WebSocket 和加密通道连进进程内的中继，再经别名访问本机的测试服务（192.0.2.10 → 127.0.0.1，2001:db8::10 → ::1）。两个族各测一遍：TCP 双向和半关闭、被拒（SYN-SENT 时就收到 RST）和被策略拦下（ICMP）、UDP、UDP 端口不可达、ping 网关、最后一跳在网关；另有生成的地址、DNS 的 A 和 AAAA、错误密钥被拒、登录、经 SOCKS5 出口（连通和被拒）、限速、额度、闲置；
  - Linux 上两个族各多一项 `ping_goes_out`：经 ping socket 真的发出去；另有一项需要外网、默认跳过的 `the_next_hop_is_out_there`（`--ignored`）：TTL 2 到 4 的 ping 从真实路由器收到「超时」。在 v2in0 的容器里全部通过（第 2 跳是 Docker 网桥，第 3 跳是上游路由器）。
- `npm run check:login` 里，真的客户机联网后拿到 IPv6 地址、ping 得通网关，再经中继的别名用 IPv6 连到本机的 press。

## 本地开发

```sh
cd relay && cargo run -- key            # 打印一把随机密钥
cat > relay.toml <<EOF
key = "…"                               # 页面里 net relay ws://127.0.0.1:8095/ 时粘贴它
EOF
cargo run -- relay.toml                 # 监听 127.0.0.1:8095；Windows 上没有 ping
npm run dev                             # /relay 代理到 127.0.0.1:8095（RELAY=host:port 可改）
```

要测 ping，就把中继跑在 Linux 上（比如 v2in0 的容器里），再用 SSH 转发；容器里用的 relay.toml 要加一行 `listen = "0.0.0.0:8095"`，默认的 127.0.0.1 在容器里，外面连不进来：

```sh
docker build -t homepage-relay relay/   # 在那台机器上
docker run -d -p 127.0.0.1:8095:8095 -v ./relay.toml:/etc/relay.toml:ro homepage-relay
ssh -N -L 127.0.0.1:18095:127.0.0.1:8095 <那台机器> &
RELAY=127.0.0.1:18095 npm run dev
```

## 部署

本站在 dmit.nrt 上（2026-10-06 从香港的 .100、.101 搬来），前面是 Cloudflare 的代理：

```
访客 ──https://arc.moe──▶ Cloudflare ──▶ dmit.nrt：Caddy（homepage-caddy，80、443）──▶ nginx（homepage-demo）
                                                                    │ Docker 网络 homepage，双栈
                                                                    ▼
                                                      homepage-relay:8095（不发布端口）──▶ 互联网，IPv4 和 IPv6
```

- **中继**：容器 `homepage-relay`，镜像 `ghcr.io/nettomew/pien-relay:<提交>`（CI 构建，见下），以 65534（nobody）运行，`--restart unless-stopped`，只接在 Docker 网络 `homepage` 上。配置在 `/srv/homepage-relay/relay.toml`（属主 65534，权限 600），只有会话密钥（和 press 的相同）；格式见 `deploy/relay.toml.example`：最多 4 个会话，闲置 2 小时断开，不限速、不限量，出口直连。
- **网络**：`homepage` 是双栈的，IPv4 `172.18.0.0/16`，IPv6 是另一段唯一本地前缀 `fdd1:31fb:31e3::/64`（和访客的那段无关：访客的网段只在中继的进程里）。两个族出门都由宿主机做 NAT。IPv6 的那份要 Docker 自己写 ip6tables 规则，Debian 12 的 Docker 20.10 里这还算实验功能，所以 `/etc/docker/daemon.json` 是 `{"experimental": true, "ip6tables": true}`。Docker 因此打开了宿主机的 IPv6 转发；eth0 的 `accept_ra` 本来就是 2，这台机器照样从路由通告拿自己的地址和默认路由。
- **nginx**：`deploy/nginx.conf` 两个族都听：容器名在双栈网络上解析出两个地址，Caddy 先拨 IPv6 的那个。`location = /relay` 按请求经 Docker 的 DNS 找中继，只问 A 记录（`ipv6=off`），中继不在时 nginx 也能启动；这一段不写访问日志。
- **Caddy**：`/srv/caddy/Caddyfile` 只有 `arc.moe { reverse_proxy homepage-demo:80 }`，整个站点连同 WebSocket 都转给 nginx，中继不用单独配置。证书走 HTTP-01，Cloudflare 的代理会放行；Cloudflare 的 SSL 模式是 Full 以上。

**发布**：推到 `main`、CI 全部通过之后，`.github/workflows/build.yml` 把三个镜像推到 GitHub 的容器仓库，各自打上提交的七位前缀和 `main`：`ghcr.io/nettomew/pien-relay`、`ghcr.io/nettomew/pien-press`，和只装着站点（`dist/`）的 `ghcr.io/nettomew/pien-site`。服务器上一行：

```sh
pien-deploy <提交>            # 或者 main：main 最后发布的那一版
pien-deploy <提交> --check    # 只拉下来、解开看一眼，正在跑的一样不动
```

`deploy/pien-deploy`（装在 dmit.nrt 的 `/usr/local/bin/`）拉下三个镜像。中继和 press 只在镜像变了时才重建容器：中继一重启，访客的网络就断了。站点解到旁边再换上去，旧的留成 `site.bak-<时间>`（只留最近三份），然后重启 nginx 和 press。容器的名字、挂载和环境变量都和以前一样，写在脚本里。

站点镜像分两层：机器的文件块（按内容命名，73.6 MB，系统没变它就不变），和其余的一切（10.6 MB）。CI 把所有文件的日期都定在 1970，没变的那层就是同一层，不再推，也不再拉。CI 里其余的缓存写在 `build.yml` 开头：npm、中继的依赖、机器（`public/vm/`，按它的全部来源和周数）、内核和工具、两个镜像的构建层。

**网络改成双栈**（2026-10-06，做过一次）：写好 `daemon.json`，停掉四个容器，`systemctl restart docker`，把它们从 `homepage` 上摘下来，删掉网络再建，再接回去、启动：

```sh
docker network create --ipv6 \
  --subnet 172.18.0.0/16 --gateway 172.18.0.1 \
  --subnet fdd1:31fb:31e3::/64 --gateway fdd1:31fb:31e3::1 homepage
```

站点停了 13 秒。当时 nginx 还只听 IPv4，Caddy 先拨 IPv6 拨不通，又报了一分半钟 502，加上 `listen [::]:80`、重载之后恢复。

**换会话密钥**：见 [login.md](login.md#部署)，press 和中继要一起换，所有登录随之作废。

**回滚**：`pien-deploy <上一个提交>`；站点也可以直接把 `site.bak-*` 挪回来，再重启 nginx。改由 CI 发布之前的最后一版是本地镜像 `homepage-relay:c0df391` 和 `homepage-press:9d7754f`，还留在机器上。IPv6：删掉 `daemon.json`，照上面的步骤重启 Docker，把网络建回只有 IPv4 的。站点：`/srv/homepage-demo/` 下有带时间戳的 `site.bak-*` 和 `nginx.conf.bak-*`。香港的旧部署停着没删，必要时整个切回去。

**上线后实测**（2026-10-06；线上的中继只认站长的登录，所以在同一台机器、同一个网络上用同一个镜像临时起了一个带密钥的中继，本机 Chrome 经 SSH 转发连上，验完即删）：`net on` 2.3 秒，第一行就列出两个地址；`ping -6 2606:4700:4700::1111` 平均 76 ms；`curl -6` 的出口是这台机器自己的 IPv6 地址，Cloudflare 的机房是 NRT；`ipv6.google.com` 200，`www.google.com` 走 IPv4（RFC 6724，见上）；`mtr -6` 七跳都在：网关 `fdca:c697:4c23::2`、Docker 网桥 `fdd1:31fb:31e3::1`、DMIT 的两台路由器、JPIX、Cloudflare、目的地；`fd00::1` 1.6 秒内被拦下。
