# 部署

pien 由三样东西组成：

- **站点**：构建出来的静态文件（`dist/`），网页、虚拟机、文章都在里面；
- **中继**（`relay/`）：`net on` 经它上网；
- **press**（`press/`）：登录，和在机器里写作；中继认的登录就是它签发的。

前面一个 nginx 照 `deploy/nginx.conf` 提供站点，把 `/relay` 和 `/api/` 转给中继和 press；再前面是 Caddy，管 HTTPS 和证书。

| 想要的 | 需要的 |
|---|---|
| 终端、文章、`drop`、`take`、`share`、借设备 | 站点，放在哪个静态托管上都行 |
| `net on` | 再加中继（或者访客自己的中继，`net relay <地址>`） |
| 站长登录，在机器里写文章、发动态 | 再加 press |

下面三条路：[用 Docker](#用-docker)（本站的做法）、[不用 Docker](#不用-docker)、[只放静态站点](#只放静态站点)。最后是[本站现在的样子](#本站)。

## 先准备

- **域名**，指到服务器。在 Cloudflare 的代理后面也行：Caddy 用 HTTP-01 拿证书，代理会放行；Cloudflare 的 SSL 模式选 Full 或更严。
- **镜像**。这个仓库的 CI 发布的 `ghcr.io/nettomew/pien-relay`、`-press`、`-site`，按提交打标签，`main` 是最新的一版；站点镜像里的文章、虚拟机里的东西都是本站的。要放自己的：fork 这个仓库，在 fork 的 Actions 页面启用工作流（fork 默认关着），在仓库的 Actions 变量里设 `SITE_URL`（比如 `https://example.com`），推到 `main`，CI 就把镜像发布到 `ghcr.io/<你>/pien-*`；包第一次推出来如果是私有的，在包的设置里改成公开，服务器才能不登录就拉。
- **会话密钥**：press 用它签登录，中继用它验，两边必须是同一把。下面的命令先生成它、写进 press 的密钥文件，再从那个文件填进中继的配置。
- **Docker**（走 Docker 那条路时）：Debian、Ubuntu 用发行版的或 Docker 官方的包；Alpine 是 `apk add docker && rc-update add docker default && rc-service docker start`。
- **GitHub 登录**（可选）：在 GitHub 建一个 OAuth App，回调地址 `https://<域名>/api/auth/github/callback`，记下 client ID 和 secret。不配，就只有通行密钥。

## 用 Docker

中继和 press 由 `pien-deploy` 建、换；Caddy 和 nginx 两个容器只建一次。容器和目录的名字（`homepage-*`）是本站沿用下来的，`pien-deploy` 认的就是它们。

```
/srv/caddy/Caddyfile                deploy/Caddyfile，example.com 换成你的域名
/srv/homepage-demo/nginx.conf       deploy/nginx.conf，原样
/srv/homepage-demo/site/            站点，pien-deploy 放进来
/srv/homepage-relay/relay.toml      deploy/relay.toml.example，填上会话密钥；属主 65534，权限 600
/srv/homepage-press/press.env       deploy/press.env.example，改成你的
/srv/homepage-press/secrets/        session.key、github.secret（可选）；目录 700，文件 600，属主都是 1000
/srv/homepage-press/data/           属主 1000：通行密钥、草稿、未发布的图片
/srv/homepage-press/content/        属主 1000：内容仓库；第一次放仓库里的 content/（或你自己的），press 自己 git init
/srv/homepage-press/public/         属主 1000：press 渲染的网页和 /content/
```

前面若是一个回源走 HTTPS、却不校验证书的 CDN，Caddy 不用去申请证书，自己签一张就行：`tls internal`，再加一句 `default_sni`，`deploy/Caddyfile` 里有写法，本站就是这样（[见下](#本站)）。站点和它的通行密钥不在同一个域名下时（比如站点在 www.example.com，通行密钥想跟着整个 example.com 走），press.env 里加 `PRESS_RP_ID`。

65534 和 1000 是中继和 press 的镜像里跑程序的用户。目录要在容器起来之前建好、属主设对：不然 Docker 会替你建一个 root 的空目录，press 写不进去，起不来。

```sh
# 模板和种子内容
git clone --depth 1 https://github.com/NettoMew/pien /tmp/pien

# 目录、配置、密钥
mkdir -p /srv/caddy /srv/homepage-demo /srv/homepage-relay \
  /srv/homepage-press/secrets /srv/homepage-press/data /srv/homepage-press/content /srv/homepage-press/public
cp /tmp/pien/deploy/Caddyfile /srv/caddy/Caddyfile                  # 改域名
cp /tmp/pien/deploy/nginx.conf /srv/homepage-demo/nginx.conf
cp /tmp/pien/deploy/press.env.example /srv/homepage-press/press.env # 改成你的
cp -r /tmp/pien/content/. /srv/homepage-press/content/
openssl rand -hex 32 > /srv/homepage-press/secrets/session.key
# printf '%s\n' '<GitHub 的 client secret>' > /srv/homepage-press/secrets/github.secret   # 用 GitHub 登录时
sed "s|^session_key = .*|session_key = \"$(cat /srv/homepage-press/secrets/session.key)\"|" \
  /tmp/pien/deploy/relay.toml.example > /srv/homepage-relay/relay.toml
chown 65534:65534 /srv/homepage-relay/relay.toml && chmod 600 /srv/homepage-relay/relay.toml
chown -R 1000:1000 /srv/homepage-press/secrets /srv/homepage-press/data /srv/homepage-press/content /srv/homepage-press/public
chmod 700 /srv/homepage-press/secrets /srv/homepage-press/data && chmod 600 /srv/homepage-press/secrets/*

# 网络、Caddy、nginx：一次就够（要 IPv6，网络换成下面那条）
docker network create homepage
docker run -d --name homepage-caddy --restart unless-stopped --network homepage \
  -p 80:80 -p 443:443 \
  -v /srv/caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v /srv/caddy/data:/data -v /srv/caddy/config:/config \
  caddy:2-alpine
docker run -d --name homepage-demo --restart unless-stopped --network homepage \
  -v /srv/homepage-demo/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /srv/homepage-demo/site:/usr/share/nginx/html:ro \
  -v /srv/homepage-press/public:/srv/press:ro \
  nginx:1.29-alpine

# 部署脚本，然后第一次部署：建出中继和 press，放上站点
curl -fsSL -o /usr/local/bin/pien-deploy https://raw.githubusercontent.com/NettoMew/pien/main/deploy/pien-deploy
chmod 755 /usr/local/bin/pien-deploy
pien-deploy main      # fork 的：PIEN_IMAGES=ghcr.io/<你>/pien pien-deploy main

# 第一个通行密钥要的一次性码；在页面的终端里 net passkey add，填它
docker exec homepage-press press enroll
```

**更新**：CI 发布之后，`pien-deploy <提交>`（或 `main`）。它拉下三个镜像；中继和 press 只在镜像变了时才重建容器，因为中继一重启，访客的网络就断了；站点解到旁边再换上去，旧的留成 `site.bak-<时间>`，只留最近三份；然后重启 nginx 和 press（nginx 的绑定挂载跟着目录走，不跟名字；press 启动时按新的样式表重新渲染网页）。`pien-deploy <提交> --check` 只拉下来、解开看一眼，正在跑的一样不动。

**回滚**：`pien-deploy <上一个提交>`。只回滚站点的话：`mv site site.bad && mv site.bak-<时间> site`（在 `/srv/homepage-demo/` 里），再 `docker restart homepage-demo homepage-press`：press 也要重启，它的网页链着站点的样式表。

**IPv6**（可选）：中继的访客要有 IPv6 出口，容器得有 IPv6。`/etc/docker/daemon.json` 写上 `{"experimental": true, "ip6tables": true}`，重启 Docker（Docker 27 起 ip6tables 默认就开着，这一步可以省掉）；上面的 `docker network create homepage` 换成这条，建成双栈：

```sh
docker network create --ipv6 --subnet 172.18.0.0/16 --subnet fdXX:XXXX:XXXX::/64 homepage
```

`fd` 后面那十位十六进制随机取（RFC 4193）；`172.18.0.0/16` 要是和机器上别的 Docker 网络撞了，换一段。容器名这时会解析出两个地址：Caddy 会先拨 nginx 的 IPv6 地址，所以 nginx 两个族都要听（`deploy/nginx.conf` 已经是）；nginx 找中继和 press 只问 IPv4（`ipv6=off`），它们只听 IPv4 就行。宿主机自己要是靠路由通告拿 IPv6 地址，`accept_ra` 得是 2，否则 Docker 打开转发后它就丢了默认路由。

## 不用 Docker

一台 Debian 或 Ubuntu，systemd 管中继和 press，nginx 在 127.0.0.1:8080 提供站点，Caddy 在前面。站点和中继直接从镜像仓库取文件，用 [crane](https://github.com/google/go-containerregistry)，一个单独的程序，不需要 Docker；也可以自己从源码构建。

```sh
# 要用的东西：nginx、Caddy（照 caddyserver.com 的说明装它的 apt 源）、
# Node 26（NodeSource）和 git（press 用），crane
apt install nginx git
curl -fsSL https://github.com/google/go-containerregistry/releases/latest/download/go-containerregistry_Linux_x86_64.tar.gz \
  | tar -xzf - -C /usr/local/bin crane

# 仓库：press 从它跑，下面的模板也在里面
git clone https://github.com/NettoMew/pien /srv/pien/src

# 用户、目录、会话密钥
useradd --system --no-create-home --shell /usr/sbin/nologin pien-relay
useradd --system --no-create-home --shell /usr/sbin/nologin pien-press
mkdir -p /etc/pien /srv/pien/press/data /srv/pien/press/content /srv/pien/press/public
openssl rand -hex 32 > /etc/pien/session.key
chown pien-press: /etc/pien/session.key && chmod 600 /etc/pien/session.key

# 站点
crane export ghcr.io/nettomew/pien-site:main - | tar -xf - -C /srv/pien site
find /srv/pien/site -exec touch -h {} +    # 镜像里的文件都记着 1970 年，nginx 的 ETag 从日期来
```

**中继**：镜像里是一个静态程序（musl），哪台 x86-64 的 Linux 上都能跑。

```sh
crane export ghcr.io/nettomew/pien-relay:main - | tar -xf - -C /usr/local/bin relay
sed -e 's|^listen = .*|listen = "127.0.0.1:8095"|' \
    -e "s|^session_key = .*|session_key = \"$(cat /etc/pien/session.key)\"|" \
    /srv/pien/src/deploy/relay.toml.example > /etc/pien/relay.toml
chown pien-relay: /etc/pien/relay.toml && chmod 600 /etc/pien/relay.toml
# ping 用的是不要特权的 ping socket，要让中继的组用得上
gid=$(getent group pien-relay | cut -d: -f3)
echo "net.ipv4.ping_group_range = $gid $gid" > /etc/sysctl.d/60-pien-relay.conf && sysctl --system
cp /srv/pien/src/deploy/systemd/pien-relay.service /etc/systemd/system/ && systemctl enable --now pien-relay
```

**press**：从仓库检出跑，Node 26 直接跑 `.ts`。press 的源码也用 `scripts/lib/` 里的几个文件，它们找的是仓库根下的 `node_modules`，所以把 press 的那份链过去（镜像里是把它们装在根上）。

```sh
cd /srv/pien/src && npm ci --omit=dev --prefix press && ln -sfn press/node_modules node_modules
cp -r content/. /srv/pien/press/content/
chown -R pien-press: /srv/pien/press && chmod 700 /srv/pien/press/data
cp /srv/pien/src/deploy/press.env.example /etc/pien/press.env   # 改成你的，路径用文件末尾那几行
# 用 GitHub 登录时：
# printf '%s\n' '<client secret>' > /etc/pien/github.secret && chown pien-press: /etc/pien/github.secret && chmod 600 /etc/pien/github.secret
cp /srv/pien/src/deploy/systemd/pien-press.service /etc/systemd/system/ && systemctl enable --now pien-press
# 第一个通行密钥要的一次性码
runuser -u pien-press -- sh -c 'set -a; . /etc/pien/press.env; exec node /srv/pien/src/press/src/main.ts enroll'
```

**nginx**：用同一份 `deploy/nginx.conf`，只改开头那几行：

```sh
sed -e 's|^    listen 80;|    listen 127.0.0.1:8080;|' -e '/^    listen \[::\]:80;/d' \
    -e 's|set $site .*;|set $site /srv/pien/site;|' -e 's|set $renders .*;|set $renders /srv/pien/press/public;|' \
    -e 's|set $relay .*;|set $relay http://127.0.0.1:8095;|' -e 's|set $press .*;|set $press http://127.0.0.1:8096;|' \
    /srv/pien/src/deploy/nginx.conf > /etc/nginx/sites-available/pien
ln -s /etc/nginx/sites-available/pien /etc/nginx/sites-enabled/pien
rm /etc/nginx/sites-enabled/default    # 它占着 80，那是 Caddy 的
nginx -t && systemctl restart nginx
```

**Caddy**：`/srv/pien/src/deploy/Caddyfile` 放到 `/etc/caddy/Caddyfile`，域名换成你的，`reverse_proxy` 改成 `127.0.0.1:8080`，`systemctl restart caddy`（装好时它和 nginx 抢过 80，可能没起来，所以是 restart，不是 reload）。

**更新**：

```sh
# 站点：解到旁边，再换上去；不用重启 nginx，它每次都按路径找文件
mkdir /srv/pien/site.new
crane export ghcr.io/nettomew/pien-site:<提交> - | tar -xf - -C /srv/pien/site.new --strip-components=1 site
find /srv/pien/site.new -exec touch -h {} +
mv /srv/pien/site /srv/pien/site.bak-$(date +%Y%m%d-%H%M%S) && mv /srv/pien/site.new /srv/pien/site
# 中继
crane export ghcr.io/nettomew/pien-relay:<提交> - | tar -xf - -C /usr/local/bin relay && systemctl restart pien-relay
# press，同一个提交：它启动时按新站点的样式表重新渲染网页，所以站点换了也要重启它
git -C /srv/pien/src fetch && git -C /srv/pien/src checkout --detach <提交>
npm ci --omit=dev --prefix /srv/pien/src/press && systemctl restart pien-press
```

不想用 crane 的话：站点是 `npm run build` 的 `dist/`（`SITE_URL=https://<域名>`，构建要先有虚拟机，见 [CLAUDE.md](../CLAUDE.md#命令)），中继是 `relay/` 里 `cargo build --release` 出来的 `target/release/relay`（这样编出来的链着本机的 glibc，在这台机器上跑没问题）。

## 只放静态站点

`dist/` 放到哪儿都行：Cloudflare Pages、Netlify 认里面的 `_headers`；用 nginx 就用 `deploy/nginx.conf`，转给中继和 press 的那两段这时只会回 502，删掉也可以。没有 press，页面就用镜像里的文章，不去服务器上找新的；`net on` 要访客用自己的中继，`net relay <地址>`。`dist/` 可以从 CI 的构件 `site` 拿，或者 `crane export ghcr.io/nettomew/pien-site:main - | tar -xf - site`。

## 本站

对外的地址是 https://arc.moe，页面实际开在 https://www.arc.moe。2026-10-06 晚上起是这样：

```
访客 ──https://arc.moe──▶ Cloudflare：301 到 www.arc.moe，路径和查询串原样带着
访客 ──https://www.arc.moe──▶ 朋友自建的 CDN（各地的节点，Let's Encrypt 的证书）
                                  │ 回源：HTTPS，源站自签的证书，不校验
                                  ▼
                       香港的一台服务器：Caddy（homepage-caddy，80、443）──▶ nginx（homepage-demo）
                                                             │ Docker 网络 homepage，双栈
                                                             ▼
                       homepage-relay:8095、homepage-press:8096（都不发布端口）──▶ 互联网，IPv4 和 IPv6
```

- **arc.moe**：在 Cloudflare 上解析到一个占位地址（`192.0.2.1`，文档用的地址，从不回源），开着代理，一条跳转规则把它 301 到 www.arc.moe。RSS 和网页版里的绝对地址都写 arc.moe：仓库变量 `SITE_URL=https://arc.moe`。
- **www.arc.moe**：朋友自建的 CDN，按地区解析到不同的节点，节点上是 Let's Encrypt 的证书。回源走 HTTPS、不校验证书；`/relay` 的 WebSocket、查询串、源站给的缓存头都照原样过。源站看到的访客地址是 CDN 节点的。
- **服务器**：Alpine 3.24，Docker 从 apk 装，照上面 [Docker](#用-docker) 那条路搭。1 核、436 MB 内存，四个容器连 Docker 一起用 230 MB 左右。它的 IPv6 默认路由是静态配的，Docker 打开转发也丢不了。
- **Caddy**：证书由 Caddy 自己的 CA 签（`tls internal`）；`default_sni` 让不报名字的回源请求也拿到它：

  ```
  {
  	default_sni www.arc.moe
  	skip_install_trust
  }

  www.arc.moe {
  	tls internal
  	reverse_proxy homepage-demo:80
  }
  ```

- **press**：`PRESS_SITE=https://www.arc.moe`，GitHub 登录的回调也在 www；`PRESS_RP_ID=arc.moe`，通行密钥属于 arc.moe，搬到 www 之前注册的照样能用。
- **中继**：以 65534（nobody）运行，配置里只有会话密钥，最多 4 个会话，闲置 2 小时断开，不限速、不限量，出口直连。
- **网络**：IPv4 `172.18.0.0/16`，IPv6 `fdd1:31fb:31e3::/64`（和访客的网段无关：那段只在中继的进程里），两个族都由宿主机做 NAT 出去；Docker 29 默认就写 ip6tables。

**来路**：

- 2026-10-04 起，在香港的两台机器上：一台的 Caddy 在前面，另一台跑着 nginx、中继和 press。
- 2026-10-06 白天，搬到东京的一台机器上，前面是 Cloudflare 的代理。那天在那里做的：中继有了 IPv6，Docker 网络改成双栈（站点停了 13 秒；nginx 当时只听 IPv4，Caddy 先拨 IPv6 拨不通，又报了一分半钟 502，加上 `listen [::]:80` 之后恢复）；发布改由 CI 来做（在那之前，镜像在一台构建机上构建、经本机中转，站点在本机构建后用 tar 传过去）。
- 2026-10-06 晚上，搬到现在这台：先停了旧机器上的 press，写作就此冻结；它的数据和中继的配置照原样（属主、权限一起）搬过来，内容索引两边一致；再起容器，换上 CDN，站点改开在 www.arc.moe。

**换会话密钥**（所有登录作废）：新密钥同时写进 `secrets/session.key` 和 `relay.toml`，press 和中继都重启。**换 GitHub 密钥**：写进 `secrets/github.secret`，重启 press。

**回滚**：东京那台机器上的四个容器停着没删：启动它们，www.arc.moe 指回那里，那边的 press 数据停在搬家那一刻，之后写的要搬回去。更早的香港部署也还停在那里。
