# 联网方案（wisp，未采用）

> **已被取代。** 这份 wisp 方案从没实现。联网用的是 Rust 写的以太网中继（`relay/`，`net on`），见 [relay.md](relay.md)；站点是东京一台服务器上的 https://arc.moe（[deploy.md](deploy.md#本站)）。WARP 直通 2026-10-05 封存（[warp.md](warp.md)）。下文的 .100、.101、test-demo.arc.moe、TypeScript 加 wisp-js 的中继、静态地址和代替 `ping` 的脚本，都只是当时的设想，留作记录。

目标：访客在终端里能 `curl https://…`、`git clone`。这台机器仍然只存在于访客的浏览器里，我们的服务器也不能因此变成一个开放代理。

## 选哪种后端

v86 自带四种网络后端（源码 `src/browser/*_network.js`）：

| 后端 | 原理 | 能做什么 | 不能做什么 | 结论 |
|---|---|---|---|---|
| `fetch` | 浏览器 `fetch()` 代发请求 | 不需要服务器 | 只处理 80 端口的明文 HTTP，客户机里 `curl https://` 直接失败；跨域还得加 CORS 代理 | 不用 |
| `wsproxy` | 以太网帧经 WebSocket 原样转发 | 完整的二层网络 | 服务器要开 TAP 网卡，访客等于接进了我们的网段，限流和过滤都很难做 | 不用 |
| **`wisp`** | 客户机的 TCP 在 v86 里终结，只把载荷经 WebSocket 多路复用转发 | 任意 TCP，HTTPS 在客户机里端到端加密；访客之间互相隔离；DHCP、DNS 由 v86 模拟 | 不支持 UDP；`ping` 的回复是 v86 本地伪造的 | **采用** |
| `inbrowser` | 同一浏览器里的多台虚拟机互联 | — | 连不了外网 | 不相关 |

## 架构

```
浏览器 v86 (virtio-net) ──wss://test-demo.arc.moe/wisp/──▶ .100 Caddy ──▶ .101 relay 容器 ──▶ 公网（只放行 80/443）
         └─ DNS: DoH ── https://test-demo.arc.moe/dns-query ──▶ 上游 DoH
```

- **中继和站点同源**：在 Caddy 现有的 `test-demo.arc.moe` 站点里加两条路由，`/wisp/*` 用现成的 `stream-proxy`，`/dns-query` 反代到上游 DoH。不需要新域名、新证书，也没有跨域问题。
- **中继本身**：一个很小的 TypeScript 服务（`relay/`），把成熟的 [wisp-js](https://github.com/MercuryWorkshop/wisp-js) 当库嵌进来，外面只包一层自己的准入和限额逻辑。放在 .101 的独立容器里，和现有的 `homepage-demo` 一样部署。
- **DNS 走自己的入口**：v86 默认用浏览器去请求 cloudflare-dns.com 做 DoH，在大陆不一定可靠，也会把查询泄露出去。把 `doh_server` 设成同源地址：既稳定，以后也方便在 DNS 层做过滤。
- **为什么不放到 Cloudflare Workers**：Workers 的出站 TCP 连不了 Cloudflare 自己的 IP 段，而大量网站都托管在 Cloudflare 后面，所以不放那里。

## 安全与防滥用（不做开放代理）

1. **目的地只放行 TCP 80/443**，UDP 全关。wisp-js 的配置是 `port_whitelist: [80, 443]` 和 `allow_udp_streams: false`。
2. **禁止访问内网**：私网、回环、链路本地、组播、CGNAT 地址，以及我们自己的公网 IP 都不让连。这要做两层：
   - wisp-js 里的 `allow_private_ips: false` 和 `allow_loopback_ips: false`；
   - 中继容器所在的 Docker 网络上，用 iptables（DOCKER-USER 链）丢弃发往 172.27.0.0/16、172.16.0.0/12、10.0.0.0/8、192.168.0.0/16 的流量。即使应用层被绕过，或者遇到 DNS 重绑定，也碰不到同一台机器上的其他内网服务。
3. **只接受自己站点的 WebSocket**：Origin 必须是 `https://test-demo.arc.moe`，挡住别的网站拿我们的中继当后端。
4. **配额**：
   - 每个 IP 最多 2 条连接，每条连接最多 16 个流；
   - 单次会话最多 64 MB 流量、约 1 MB/s 速率；
   - 空闲 5 分钟断开，最长持续 1 小时；
   - 客户端真实 IP 从 Caddy 传来的 `X-Real-IP` 取。
5. **留痕和总开关**：日志只记客户端 IP、目的 IP:端口、字节数，保留 7 天。一个环境变量就能关掉中继，页面随即显示「网络维护中」。
6. **出了问题再升级**：如果发现滥用，接 Cloudflare Turnstile，先过人机验证、拿到短期令牌才能连中继。另外要知道一个风险：所有出站流量都用我们的 IP，必要时可以把中继迁到单独的出口机器。

wisp 的连接请求里只有 IP 没有域名（v86 先在浏览器里解析好 DNS），所以中继这一层没法按域名过滤。以后真要做按域名的白名单，有两种办法：在自己的 DoH 上只解析白名单里的域名；或者在中继里读 TLS 握手中的 SNI。

## 对首屏和启动的影响

- **页面不变**：网络后端已经包含在 libv86 里，不多下载任何 JS。
- **内核**：要加 `INET`、`PACKET`、`NETDEVICES`、`VIRTIO_NET`，预计内核大约 +0.3 MB，快照 +0.1～0.2 MB。
- **网卡和快照**：网卡要在存快照时就存在。IP 在构建时就静态配好（192.168.86.100，网关和 DNS 都是 .1），恢复快照后不用再走 DHCP。开启 `preserve_mac_from_state_image`，避免 MAC 地址被随机化后客户机收不到包。
- **不用网络的访客不连中继**：v86 的 wisp 客户端一构造就建立 WebSocket。我们给它包一层懒连接的 WebSocket（约 30 行）：客户机第一次向外发起连接时才真正拨号，在那之前发的数据先缓存。
- **新增软件按需下载**：curl、CA 证书等只在第一次用到时下载（约 2～3 MB，只下一次）。状态栏照常显示每一次加载。

## 手机上

- WebSocket 在手机上没问题。页面切到后台时连接会被挂起，所以监听 `visibilitychange`，回到前台立即重连，不必等 v86 自带的 10 秒重连。
- 状态栏加一个网络指示，例如 `⇅ 已连接 · 1.2 MB · → wttr.in`。目的地域名从我们自己的 DoH 应答里反查得到。流量用量一直可见，访客用的是自己的流量。
- 快捷键栏加一个 `curl wttr.in` 示例。

## 客户机里的体验

- **示例命令**：`curl wttr.in/Hong_Kong`（终端版天气）、`curl cheat.sh/tar`、`git clone https://github.com/…`。
- **`net` 命令**：显示连接状态、已用流量和限额。
- **`ping` 换成 TCP 测速**：wisp 走不了 ICMP，v86 回的 ping 是假的。所以把 `ping` 换成一个 TCP 测速脚本：连接目标的 443 端口，计时，打印「经 TCP 443」，测的是真实往返时间，而不是假装能 ping。
- **网络不可用时**：中继关闭或连不上，就给出明确的中文提示，而不是一直卡着。

## 实施步骤

1. **客户机**：
   - 改内核配置，在镜像里加 curl、ca-certificates、静态网络配置、`net` 和 `ping` 两个脚本；
   - 在 `vm.config.ts` 里加 `net_device`（virtio、wisps 地址、`doh_server`、`preserve_mac_from_state_image`），加懒连接 WebSocket，重建快照；
   - 本地开发时在 Vite 里把 `/wisp` 代理到本机的 `npx wisp-js-server`。
2. **中继**：`relay/` 服务和 Dockerfile，部署到 .101，配好专用 Docker 网络和 iptables；在 Caddy 的站点里加 `/wisp/*` 和 `/dns-query` 两条路由（照例先备份、校验再重载）。
3. **体验**：状态栏网络指示、`help` 和欢迎语更新、后台切回时重连、离线提示。
4. **加固**：冒烟测试加一条 `curl wttr.in`（CI 里起一个本地中继）；滥用演练（连内网、连 25 端口、超额度都必须失败）；视情况接 Turnstile。
