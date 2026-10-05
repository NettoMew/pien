# 登录（`net login`）

站点只有一个账号：站长自己的。没有口令。通行密钥（passkey）是正门，GitHub 是从还没有通行密钥的设备回来的后门。登录一次管 30 天，中继和以后的发布共用它。

```
客户机 net login ──OSC 7337 ask──▶ 页面（src/account/）──/api/──▶ press（press/）
                                    │ 通行密钥：浏览器自己的对话框
                                    │ GitHub：另开一个窗口，结果经 BroadcastChannel 回来
                                    ▼
                         登录 = token + 通道密钥，存在这个浏览器里
页面 ──"GHR2" ‖ … ‖ token──▶ relay：自己验 token、派生通道密钥，不问任何人
```

## 客户机里

| | |
|---|---|
| `net login` | 用通行密钥登录（浏览器弹出它自己的对话框） |
| `net login github` | 用 GitHub 登录：另开一个窗口（电脑上是弹窗，手机上是新标签页），页面和里面的机器都不动 |
| `net logout` | 忘掉这个浏览器里的登录 |
| `net passkey` | 列出通行密钥，以及关联的 GitHub 账号 |
| `net passkey add [名字]` | 在这台设备上新建一个通行密钥；名字默认是「系统 · 浏览器」 |
| `net passkey remove <n>` | 删掉第 n 个；唯一的那条路（只剩一个且没关联 GitHub）删不掉 |
| `net github` | 关联 GitHub 账号（要先登录）；之后 `net login github` 才认它 |
| `net` | 在不在线、走哪个中继、登录到哪天 |

`net on` 走本站中继时发现没登录，会先自己跑一遍 `net login`，再接着连。

## 第一个通行密钥

账号是空的时候，谁也登不进去，所以第一个通行密钥要一个服务器自己给的一次性码：

```sh
docker exec homepage-press press enroll
```

打印一个 16 位的码（`XXXX-XXXX-XXXX-XXXX`，字母表去掉了容易看错的 0/O、1/I/L），15 分钟内有效，用一次就作废，猜错 5 次也作废。在客户机里 `net passkey add`，它会问这个码，大小写和横线都无所谓。加好以后直接就是登录状态。

以后在新设备上：`net login github`，再 `net passkey add`。

## 手机上：点一下屏幕上的键（`src/gesture.ts`）

浏览器只在访客点按或按键的那一刻允许弹窗、选文件、选设备、调通行密钥。在机器里敲命令回车后，请求要先经过终端和客户机再回到页面：桌面浏览器还把那一下按键算作访客的操作，手机不算，直接拦掉。所以这类动作先试着直接做；浏览器拒绝了，屏幕下方就浮出一枚键帽，比如「Continue with GitHub」，点一下（或者按 Enter）就接着做，Esc 或 ✕ 取消。桌面上几乎见不到它。`drop`、`serial`、`adb`/`fastboot` 选设备，以及通行密钥，都走同一个机制。

GitHub 在手机上开在新标签页里。回调页除了经 BroadcastChannel 告诉页面，还把同样的结果留在 localStorage 里（十分钟内有效）：原来的标签页被冻结了，切回来时自己去看；被系统回收了，重新加载后第一次问到登录时接过来。

## 登录长什么样（`press/src/tokens.ts`，`relay/src/token.rs`）

```
body      版本 1（1）‖ 到期时间，Unix 秒（8，大端）‖ id（16，随机）
token     body ‖ HMAC-SHA256(会话密钥, "guest@home session v1" ‖ body)
通道密钥  HMAC-SHA256(会话密钥, "guest@home channel v1" ‖ body)
```

- 会话密钥只在服务器上：press 和中继各有一份（同样的 64 位十六进制）。服务器上**没有登录列表**：token 自己证明自己，到期就失效。要让所有登录立刻失效，换掉会话密钥就行。
- press 登录时把 token 和通道密钥一起交给页面。中继从 token 自己算出通道密钥。只在日志里看到 token 的人，打不开中继的通道。
- 两边用同一组测试向量（`agrees_with_press`、`the same bytes as the relay`），保证字节一致。

## 问答通道（`src/ask.ts`，`__ask.fish`）

`net login` 这类命令要问页面、等页面答。客户机打印

```
ESC ] 7337 ; ask ; <暗号> ; <id> ; <话题> ; <词> … BEL
```

（每个词 URL 转义），页面按话题加载对应的模块（`net` → `src/net/answers.ts`），答案经控制线回去：每行一条 `said <id> <内容>`，最后 `done <id> <状态>`，hostd 写进 `/run/ask/`，`__ask` 读出来。状态 0 是好，3 是「还要一样东西」（码、中继的密钥），别的是不行。

暗号每个页面新生成一个，问候客户机时交给 hostd，存在 `/run/ask/secret`，只有 guest 自己的命令读得到。所以终端里**显示**出来的东西，比如 `cat` 一个恶意文件，没法冒充站长去问页面（`check:login` 专门试了一次）。

## press（`press/`）

一个 TypeScript 小服务，Node 26 直接跑 `.ts`，唯一的依赖是 `@simplewebauthn/server`。路由是从 `Request` 到 `Response` 的函数，测试直接调用，不用起端口。

| | |
|---|---|
| `POST /api/auth/passkey/options` | 登录要签的挑战（5 分钟，用一次） |
| `POST /api/auth/passkey/login` | `{ response }` → 登录 |
| `POST /api/auth/passkey/register/options` | `{ code? }` 新通行密钥要签的挑战：要登录，或者 enroll 的码 |
| `POST /api/auth/passkey/register` | `{ response, name, code? }`；用码注册的同时登录 |
| `GET /api/auth/passkeys` | 列表和 GitHub 账号 |
| `DELETE /api/auth/passkeys/:id` | |
| `GET /api/auth/github` | GitHub 窗口的第一页：去 GitHub 登录 |
| `POST /api/auth/github/link` | 已登录时要一个关联用的地址，窗口再去那里 |
| `GET /api/auth/github/callback` | 从 GitHub 回来：结果经 BroadcastChannel 告诉页面，也留在 localStorage 里，窗口自己关掉 |

- 通行密钥：rpId 是站点的主机名 `arc.moe`，子域上的页面也能用同一批通行密钥，只要在 `PRESS_ORIGINS` 里列出来。可发现凭据，登录时不用输用户名。
- GitHub：不要任何权限（no scopes），只为知道「是谁」；拿到身份后立刻把 GitHub 的 token 还回去（DELETE）。来回一趟用 HttpOnly cookie 绑在发起它的浏览器上，所以别人点不进你的登录。
- 账号存在 `PRESS_DATA/account.json`（权限 600），写入先写旁边再改名，不会半截。
- 配置全在环境变量里，见 `press/src/config.ts` 开头和 `deploy/press.env.example`。

## 中继

本站中继只认登录（`session_key`），不再有口令。自己搭的中继认自己的密钥（`key`，`relay key` 生成）：`net relay <地址>` 第一次会问，粘贴一次以后按地址记在浏览器里；密钥不对会被忘掉，下次 `net on` 再问。详见 [relay.md](relay.md)。

## 测试

- `npm test --prefix press`：软件实现的通行密钥（`press/test/authenticator.ts`，none 证明）走完注册、登录、重放、跨源、删除，加上模拟的 GitHub 走完关联和登录；token 的字节和中继对齐。
- `npm run check:login`（要先 `npm run build`）：本机起中继和 press，`vite preview` 在前面，Chrome 的虚拟认证器扮通行密钥，在客户机里把第一个通行密钥、登出登入、列表、伪造的提问、经本站中继上网、自己的中继、错误的密钥都走一遍。CI 在跑。

## 部署（.101）

```
/srv/homepage-press/
  press.env            deploy/press.env.example
  data/                属主 1000：account.json
  secrets/session.key  属主 1000，600：会话密钥，和中继 relay.toml 的 session_key 相同
  secrets/github.secret 属主 1000，600：GitHub OAuth 的 client secret
```

```sh
docker run -d --name homepage-press --restart unless-stopped --network homepage \
  --env-file /srv/homepage-press/press.env \
  -v /srv/homepage-press/data:/data -v /srv/homepage-press/secrets:/run/secrets:ro \
  homepage-press:<提交>
```

nginx 把 `/api/` 转给它（`deploy/nginx.conf`）。GitHub OAuth App 的回调地址是 `https://arc.moe/api/auth/github/callback`。

**换会话密钥**（所有登录作废）：新密钥同时写进 `secrets/session.key` 和中继的 `relay.toml`，两个容器都重启。**换 GitHub 密钥**：写进 `secrets/github.secret`，重启 press。
