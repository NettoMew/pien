# WARP 直通

访客在终端里敲 `net warp`，这台虚拟机就作为一台真正的主机接入互联网，出口是 Cloudflare WARP。`curl`、`git`、真实的 `ping` 和 UDP DNS 都能用。不用我们的出口 IP，也没有开放代理。

和 [network.md](network.md) 里的自建 wisp 中继相比，服务器上只剩一根「哑管道」：只能连 WARP 的一个入口，只看得到 TLS 密文。

**现状（2026-10-04）**：原型已在本机跑通（W1–W4），线上还没部署（W6 待确认）。

## 原型实测

在 Chrome 里打开 `vite preview` 的生产构建，访客侧的边缘入口经 v2in0（香港）转发：

| | |
|---|---|
| 第一次 `net warp`（按 y 之后） | 4.1 秒连上：注册、下载 wasm、TLS 握手、CONNECT、配好 eth0；5.8 秒打印出口（第一次跑 curl，含下载 curl 本身） |
| 再次 `net warp`（凭据已存） | 1.7 秒，不再显示说明 |
| `curl …/cdn-cgi/trace` | `warp=on`，`colo=HKG`，`http=http/2` |
| `ping -c 4 1.1.1.1` | 4/4，平均 40 ms，真实的 ICMP |
| `curl https://github.com/` | 200；DNS 0.04 s，TLS 0.64 s，共 1.0 s |
| 下载 5 MB | 1.7 MB/s，瓶颈在模拟出来的 CPU（客户机里的 TCP 和 OpenSSL） |
| `net forget` | DELETE 返回 204，浏览器里的凭据清空 |
| warp.wasm | 379 KB；gzip 139 KB，brotli 111 KB（Go 版 brotli 后 3.1 MB） |
| 页面 JS | 按需加载的部分 gzip 后约 3.6 KB；首页的包没有变大 |
| 客户机 | 内核 1.4 → 1.6 MB，快照 5.0 → 5.3 MB；curl 和 OpenSSL 等库按需加载 |

## 协议（读 usque 源码，实测确认）

1. **TCP** 连 `162.159.198.2:443`。
2. **TLS 1.3**：
   - SNI 是 `consumer-masque.cloudflareclient.com`，ALPN 是 `h2`；
   - 客户端出示一张自签名证书，私钥是注册时上传过公钥的 ECDSA P-256 密钥；
   - 服务端证书不走 CA 校验，而是检查它的公钥和注册时拿到的公钥一致（钉公钥）；
   - 实测这一组就够了：ChaCha20-Poly1305，P-256 密钥交换，ECDSA P-256 签名。
3. **HTTP/2**：在流 1 上发一个普通的 `CONNECT cloudflareaccess.com:443`（不是 RFC 8441 的扩展 CONNECT），带 `cf-connect-proto: cf-connect-ip` 和 `pq-enabled: false`，响应 `:status 200`。
4. **capsule**：请求体和响应体都是一串 capsule。类型 `0` 是 DATAGRAM，载荷就是一个裸 IP 包，不带 RFC 9484 的 context ID，这是 Cloudflare 的非标准实现。其他类型读过就忽略。
5. **注册**，两步：
   - `POST /v0a4471/reg`：随机的 WireGuard 公钥、`tos` 时间戳、随机序列号，返回 `id` 和 `token`；
   - `PATCH /v0a4471/reg/{id}`：上传 P-256 公钥（SPKI DER 的 base64），`key_type: secp256r1`，`tunnel_type: masque`，返回服务端公钥（PEM）和分配的地址（`172.16.0.2`）。
   - 删除设备用 `DELETE /v0a4471/reg/{id}`，返回 204。

## 整体结构

```
fish: net warp ──OSC 7337──▶ 页面（按需加载 src/warp/）
                                 │ 首次：经 /warp/api/ 注册，凭据存在访客的 localStorage
v86 virtio-net ⇄ bus net0-send/receive ⇄ warp.wasm（以太网 ⇄ IP ⇄ capsule ⇄ HTTP/2 ⇄ TLS）
                                 │ 加密后的字节
                       WebSocket /warp/edge ──▶ websockify ──▶ 162.159.198.2:443
hostd（root，ttyS1）◀── net up / net down ── 页面
```

## Rust crate：`warp/`

**纯状态机，自己不做 I/O。**输入是字节，输出也是字节。WebSocket、定时器、v86 总线都归 TypeScript 管；Rust 里没有异步运行时、没有线程，也没有 `wasm-bindgen`。rustls 关掉了 `std` 特性，用它的 unbuffered API：`std` 特性要读系统时钟，而 `wasm32-unknown-unknown` 上没有系统时钟。

| 模块 | 职责 | 依赖 |
|---|---|---|
| `abi.rs` | wasm 接口：几个整数函数，单例隧道 | — |
| `tunnel.rs` | 把各层串起来：处理 TLS 记录、CONNECT 之后搬运 capsule、保活、各种断开原因 | `rustls` |
| `crypto.rs` | 自己写的最小 rustls 加密后端：只支持 TLS 1.3、一个套件 `TLS13_CHACHA20_POLY1305_SHA256`、一个密钥交换组 secp256r1、一种签名 ECDSA P-256 + SHA-256；随机数和时间从宿主导入 | `rustls`、`chacha20poly1305`、`p256`、`sha2`、`hmac` |
| `tls.rs` | 钉公钥：从证书里取出公钥，和注册时拿到的比较，再用它验签 CertificateVerify；客户端证书；SNI、ALPN；关掉会话恢复 | `rustls` |
| `cert.rs` | 极小的 DER：生成自签名证书（序列号 0、名字为空、有效期一天），从证书里取出 SPKI，ECDSA 签名的 DER 编解码 | `p256` |
| `h2.rs` | 只跑一条流的 HTTP/2：连接前言、SETTINGS、`CONNECT`（HPACK 只用不索引的字面量编码）、DATA、双向流量控制、PING、GOAWAY、RST_STREAM。响应头只解码第一个字段 `:status`：伪首部一定排在最前，而且第一个头块时 HPACK 动态表还是空的 | — |
| `capsule.rs` | QUIC 变长整数，DATAGRAM capsule 的封装和拆分 | — |
| `link.rs` | 以太网 ⇄ IP：学习客户机的 MAC；对任何 ARP 请求都用网关 MAC `02:77:61:72:70:01` 应答；IPv4 帧去掉以太网头送出去，回来的 IP 包加上以太网头；原型不支持 IPv6 | — |

**wasm 接口**（TypeScript 端的封装是 `src/warp/core.ts`）：

```text
导出  memory
      input(len) -> ptr        一块输入缓冲区，JS 先把数据写进去，再调用下面某个函数
      open() -> bool           输入：设备私钥（32 字节）‖ 入口的 SPKI；开始 TLS 握手
      from_socket()            输入：WebSocket 收到的字节
      from_guest()             输入：客户机发出的一个以太网帧
      tick()                   每 10 秒调用一次：发 PING 保活，连续 3 次没回应就算断开
      close()
导入  host.to_socket(ptr, len)          要送进 WebSocket 的字节
      host.to_guest(ptr, len)           要送进客户机的一个以太网帧
      host.event(kind, code, detail)    连上；或者断开，并附上原因
      host.random(ptr, len)             crypto.getRandomValues
      host.now() -> f64                 Date.now()
```

**体积：brotli 后 111 KB**，目标是 200 KB 以内。做法：
- 编译选项：`opt-level = "z"`、`lto = "fat"`、`codegen-units = 1`、`panic = "abort"`、`strip`；
- 只编进一个套件、一个密钥交换组、一种签名算法，整个 crate 只用 P-256 一条曲线；
- 不用 webpki 校验证书；不用 `wasm-bindgen`、`js-sys`、`getrandom`；
- 密钥对由页面用 WebCrypto 生成，wasm 里不带密钥生成的代码。
- `wasm-opt -Oz` 能把原始体积压掉 16%，但压缩后几乎不变（gzip 少约 2 KB），所以不用。

## 页面：`src/warp/`

- **`index.ts`（常驻，很小）**：转交 `net warp`、`net off`、`net forget`，按需 `import()` 下面这些；页面加载时告诉客户机「这个浏览器已经有设备」（`net known`），客户机据此跳过说明。
- **`session.ts`**：
  - 加载 wasm，准备凭据，连 `WebSocket(/warp/edge)`；
  - 接上 v86 总线：`net0-send` 进 wasm，wasm 产出的帧发回 `net0-receive`；
  - 每 10 秒调一次 `tick()`；页面从后台回到前台时，如果之前断了，自动重连；
  - 用控制行告诉 hostd 结果：`net up 172.16.0.2`，或 `net down <原因>`。
- **`api.ts`**：调注册 API，凭据存进 `localStorage["warp"]`，包括 id、token、私钥、入口公钥和分到的地址。页面和 `scripts/warp.ts` 共用这份代码。
- **`core.ts`**：wasm 接口的类型化封装。
- **状态栏**：`⇅ WARP ↓1.2 MB ↑0.3 MB`；连接中显示琥珀色，断开显示灰色。

## 客户机

- **内核**：加 `INET`、`NETDEVICES`、`NET_CORE`、`VIRTIO_NET`；不跑 DHCP，不需要 `PACKET`。
- **v86**：`net_device: { type: "virtio", mtu: 1280 }` 和 `preserve_mac_from_state_image`。没有 `relay_url`，所以 v86 不自带网络后端，帧完全由页面处理。顺带去掉了 v86 默认插着的那块 NE2000 网卡。
- **快照里的网卡**：快照里有 eth0（MTU 1280），但没有地址、没有路由。不联网时程序会立刻报 Network unreachable，不会卡住。
- **`hostd`**（root，ttyS1）：
  - `net up <地址>`：给 eth0 配上 `/32` 地址、到 `172.16.0.1` 的主机路由和默认路由；
  - `net down <原因>`：撤掉这些；
  - 两者都会把结果写进 `/run/net/state`。
- **`rc`**：启用 `lo`，打开 `ping_group_range`，让普通用户也能 ping。
- **`/etc/resolv.conf`**：`1.1.1.1`、`1.0.0.1`。
- **软件包**：加了 curl。curl、OpenSSL 和 CA 证书都只在第一次用到时才下载。
- **`net` 命令**（`net.fish`）：
  - `net`：显示状态；
  - `net warp`：第一次先显示说明、等访客确认；连上后用 curl 访问 `1.1.1.1/cdn-cgi/trace`，打印出口 IP 和节点；
  - `net off`：断开；
  - `net forget`：删掉 Cloudflare 那边的设备和浏览器里的凭据；
  - 失败时用中文说明原因：注册被限流、连不上中转、设备已失效、公钥不符……并提示不联网也能看的内容。

第一次 `net warp` 时显示：

```
net warp 用一个非官方客户端，
把这台机器接入 Cloudflare WARP。

· 第一次用会为你匿名注册一个设备，
  密钥只存在你的浏览器里。
· 流量经本站转发给 Cloudflare，本站
  只看得到加密的字节；注册请求也经
  本站转发。
· 这不是 Cloudflare 的官方服务，
  随时可能失效。
· 继续即表示接受 Cloudflare 的条款：
  https://www.cloudflare.com/application/terms/

继续吗？[y/N]
```

## 两根管道

| | 本地开发（`vite dev` / `vite preview`） | 线上（待确认） |
|---|---|---|
| `/warp/edge`（WebSocket ⇄ TCP） | `scripts/lib/warp-pipes.ts`：在 upgrade 时用 `ws` 接住，连 `162.159.198.2:443`（环境变量 `WARP_EDGE` 可改） | websockify 容器：`websockify --heartbeat 30 0.0.0.0:8080 162.159.198.2:443` |
| `/warp/api/`（注册） | 同一个插件：代理到 `https://api.cloudflareclient.com`，只放行 `/v0a…/reg[/<id>]`，补上 `User-Agent: WARP for Android` | nginx 的 `location`，规则同左 |

**注册为什么不走第二根 websockify 管道**：那样 wasm 里得自己做一套带 CA 根证书的 TLS，体积要多约 150 KB。改用固定上游、只放行固定路径的 HTTPS 反向代理，安全性质不变，wasm 也保持很小。代价是注册请求（包括 token）会经过我们的服务器。

**线上部署**（待确认）全部写在仓库里：
- `deploy/compose.yaml`：现有的 nginx 加一个 websockify 服务；
- `deploy/nginx.conf`：新增 `/warp/edge` 和 `/warp/api/` 两段：
  - 校验 `Origin`；
  - 用 `real_ip` 取出 Caddy 转来的访客 IP；
  - 用 `limit_conn` 限制每个 IP 最多 2 条隧道，用 `limit_req` 限制注册每分钟 5 次。
- .100 的 Caddy 不用改：它本来就把整个站点（包括 WebSocket）转给 .101 的 nginx。

**前提**：.101 自己要连得上 WARP 入口。这台开发机所在的网络连不上：TCP 能连，但 TLS 一看到这个 SNI 就被复位。所以上线前要先确认 .101 的出口。

## 本地开发

```sh
npm run build:warp                          # 编 wasm（需要 rustup target add wasm32-unknown-unknown）
cargo test --manifest-path warp/Cargo.toml  # 单元测试：RFC 7541 / RFC 9000 测试向量、HTTP/2、ARP、DER
npm run warp -- register                    # 用 Node 注册一个开发用设备 → .cache/warp/
cargo run --manifest-path warp/Cargo.toml --example edge -- .cache/warp/open.bin [入口地址]
npm run warp -- delete                      # 用完删掉
```

`examples/edge.rs` 不经过浏览器，直接用 TCP 连入口，扮演客户机去 ping 1.1.1.1、8.8.8.8 和一个不可达的地址。

如果本机连不上入口，就借一台连得上的机器开 SSH 转发，再让开发服务器走这条转发：

```sh
ssh -N -L 127.0.0.1:18443:162.159.198.2:443 v2in0
WARP_EDGE=127.0.0.1:18443 npm run dev
```

## 测试

1. **`cargo test`**（CI 已经在跑）：用 RFC 测试向量测 QUIC 变长整数（RFC 9000）和 HPACK 的 `:status`（RFC 7541）；另外测 HTTP/2 的帧、流量控制和结束方式、ARP 应答、以太网帧的拆装、DER 证书和签名。
2. **离线端到端**（下一步）：`scripts/fake-edge.ts` 用 Node 自带的 `tls` 和 `http2` 起一个假的 WARP 入口：
   - 要求客户端证书，处理带 `cf-connect-proto` 的 CONNECT；
   - 收到 ICMP echo 就原样回复；
   - 配一个假的注册 API，下发假入口的公钥。

   冒烟测试在浏览器里跑 `net warp`，然后 `ping`，从钉公钥到以太网适配整条链都测到，而且不连 Cloudflare。
3. **在线测试**（手动）：真的注册一个设备，在浏览器里跑 `curl https://1.1.1.1/cdn-cgi/trace`，最后 `net forget`。

## 实施步骤

1. ~~**W1 核心**：Rust crate 和 `examples/edge.rs`，直连真实入口。~~ 完成
2. ~~**W2 wasm**：`scripts/build-warp.ts`、体积、`src/warp/core.ts`、开发管道。~~ 完成
3. ~~**W3 客户机**：内核网络、virtio 网卡、`hostd`、`net` 命令、curl。~~ 完成
4. ~~**W4 页面**：按需加载、注册和凭据、状态栏、首次说明、失败提示。~~ 完成
5. **W5 测试**：离线的假入口端到端测试进 CI；在线测试脚本。
6. **W6 上线**（等确认）：在 .101 加 websockify，改 nginx 配置。
7. **W7 打磨**：IPv6、继续压体积、`net` 写进欢迎语。

## 待确认

- **注册方式**：每个访客各自注册（现在的做法），还是共用一小池凭据？
- **线上管道**：放在 .101，经 nginx 转发（.100 不用改）？上线前要先确认 .101 连得上 WARP 入口。
- **流量**：WARP 的所有流量都会经过 .101 中转，要不要给每个访客设流量上限？
