# 中继（`net on`）

访客在终端里敲 `net on`，这台虚拟机就拿到一段私有的网络，经中继出门：`ip a`、`curl`、`git`、真实的 `ping`、DNS 都能用。设计上只给站长自己用：要口令。

```
v86 eth0 ──帧──▶ 页面（src/net/relay.ts）══WebSocket，内层加密══▶ Caddy ──▶ relay（relay/）──▶ 互联网
                                                                  每条连接一段私有网段：
                                                                  10.0.2.15 访客 · 10.0.2.2 网关 · 10.0.2.3 DNS
```

另一条路是 Cloudflare WARP（`net warp`，试验，见 [warp.md](warp.md)）。两者共用一个入口（`src/net/index.ts`），同一时刻只接一种。

## 中继：`relay/`

一个 Rust 静态二进制，Docker 镜像 7.6 MB。每条 WebSocket 就是一段独立的虚拟网段，和 QEMU 的 user 网络（slirp）一样：

| | |
|---|---|
| 线路格式 | 一条二进制消息就是一个以太网帧，和 v86 的 wsproxy 一样，只是外面多一层加密 |
| L2 | smoltcp 回 ARP，学访客的 MAC；网关 MAC 用 QEMU 的 `52:55:0a:00:02:02` |
| TCP | smoltcp 扮演网关一端。**先真的连上目标，再回访客的 SYN**：对方拒绝就回 RST（curl 报 Connection refused），连不上就回 ICMP 主机不可达，和真实网络一样 |
| UDP | 绕过 smoltcp：每个（访客端口，目的地）一个真实的 UDP socket，闲置 60 秒回收 |
| ICMP | ping 走 Linux 的非特权 ping socket（`ping_group_range`；容器里默认对所有组开放）；回给访客的 echo reply 由中继构造 |
| DNS | 发往 10.0.2.3:53 的查询由中继解析；上游默认走 DoT（Cloudflare），也可以配 Quad9、Google、系统解析或某个地址；可以配静态 hosts |
| 策略 | 默认只放行公网：私网、回环、链路本地、CGNAT、文档段、组播、保留地址都拦下（回 ICMP「主机被禁止」）。检查的是**真正要连的地址**，所以 DNS 指向内网也没用。端口白名单、黑名单（默认拦 25）、别名（把某个访客地址映射到真实地址，不受检查） |
| 出口 | TCP 直连，或者经 SOCKS5（比如本机的 Mayami）；UDP 和 ICMP 直连 |
| 限额 | 会话数（默认 4）、每会话 TCP 连接数（256）、闲置超时（30 分钟） |
| 记录 | 只有计数：会话数、拒绝次数、上下行字节、连接数。**不记录任何目的地址** |

### 内层加密（`relay/src/channel.rs`）

为了让前面的 TLS 终结者（Caddy）和它的日志看不到帧，WebSocket 里面再套一层：

```
页面 → 中继   "GHR1" ‖ 页面随机数(16) ‖ 页面 P-256 临时公钥(65)
中继 → 页面   中继随机数(16) ‖ 中继 P-256 临时公钥(65)
密钥          HKDF-SHA256(ikm = 预共享密钥 ‖ ECDH, salt = 两个随机数, info = "guest@home relay v1")
              → 页面→中继、中继→页面各一把 AES-256-GCM 密钥
之后          每条消息 AES-256-GCM，nonce = 4 个零字节 ‖ 64 位计数器
              页面先发 "hello"，中继回 "welcome"，然后一条消息一个以太网帧
```

- 预共享密钥是口令的 PBKDF2-HMAC-SHA256（60 万轮，盐 `guest@home relay`）。`net login` 在页面里算出它，**只存密钥，口令本身既不存也不上线**；中继的配置里也只放密钥（`relay key` 生成）。
- 临时 ECDH 提供前向保密；两边的随机数让旧消息无法重放，计数器保证顺序。
- 口令错了，中继在一秒后以 1008 关闭，访客看到「中继不认这个口令」。
- 页面那边全部用 WebCrypto 实现，不需要 wasm。

## 页面：`src/net/`

- `index.ts`（常驻）：`net on`、`net off`、`net login`、`net logout`、`net warp`、`net forget` 依次排队处理；同一时刻只有一种方式接在网卡上，切换时旧的那种安静地断开。
- `relay.ts`（用到时才加载）：口令派生密钥、握手、逐帧加解密（保证顺序）、状态栏 `⇅ 中继 ↓… ↑…`、页面从后台回来时自动重连。
- 中继地址：构建时用 `VITE_RELAY_URL` 指定，默认是同源的 `<base>relay`。

## 客户机

- `net on` 时，hostd 收到 `net up relay 10.0.2.15/24 10.0.2.2 10.0.2.3 1500`，配好 eth0、路由和 `/etc/resolv.conf`；没联网时 eth0 没有地址，程序会立刻报 Network unreachable，不会卡住。
- 第一次 `net on` 发现没有口令时，直接提示输入，输入完自动重试。
- 访客用户的 PATH 加了 `/sbin`，`ip a`、`ip route` 直接能敲。
- 失败时给出中文原因：没口令、口令不对、中继正忙、连不上中继、连接断了……

## 实测（本机浏览器 → SSH 转发 → v2in0 上的中继容器，香港）

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
  - 单元测试：报文构造、加密通道（错误密钥、重放、乱序）、配置、策略；
  - 端到端：smoltcp 扮演一台有以太网和 ARP 的访客，经真实的 WebSocket 和加密通道连进进程内的中继，再经别名访问本机的测试服务：TCP 双向和半关闭、被拒（SYN-SENT 时就收到 RST）、被策略拦下（ICMP）、UDP、DNS、ping 网关、错误密钥被拒。

## 本地开发

```sh
cd relay && cargo run -- key            # 输入口令，得到密钥
cat > relay.toml <<EOF
key = "…"
EOF
cargo run -- relay.toml                 # 监听 127.0.0.1:8095；Windows 上没有 ping
npm run dev                             # /relay 代理到 127.0.0.1:8095（RELAY=host:port 可改）
```

要测 ping，就把中继跑在 Linux 上（比如 v2in0 的容器里），再用 SSH 转发：

```sh
docker build -t homepage-relay relay/   # 在那台机器上
docker run -d -p 127.0.0.1:8095:8095 -v ./relay.toml:/etc/relay.toml:ro homepage-relay
ssh -N -L 127.0.0.1:18095:127.0.0.1:8095 <那台机器> &
RELAY=127.0.0.1:18095 npm run dev
```

## 部署（R4，待确认）

- 放在哪台机器、Caddy 怎么配，都等用户确认。
- 推荐放在 .101 的容器里（ping socket 已默认开放，`ping_group_range` 是 0–2147483647），由 nginx 或 Caddy 把 `/relay` 转给它；出口就是那台机器的 IP，也可以配 SOCKS5 交给 Mayami。
- 浏览器到中继之间的帧有内层加密，Caddy 的访问日志里也只有路径，没有口令。
