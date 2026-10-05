# 写作（`blog edit`、`moments new`）

文章和动态都在这台机器里写、在这台机器里发，网站和每个访客的机器随即都有，不用重建虚拟机。只有站长能写：要先登录（[login.md](login.md)）。

```
客户机 blog edit sky ──ask──▶ 页面（src/writing.ts）──/api/──▶ press（press/src/writing.ts）
  ~/drafts/sky.md              直接读客户机里的文件；         草稿：press 自己的数据里
  （在 edit 或 nano 里写）      图片先送 press                 发布：内容仓库（git），一次一个提交
                                                              渲染：/content/ 和网页（render.ts）
页面打开时 ◀── /content/index.json：比机器里的新，就把差别铺进 ~（src/content.ts，hostd 的 content）
```

## 内容的样子（`scripts/lib/content.ts`）

和客户机的家目录一一对应：

```
blog/<文章>.md        front matter：title、date、tags
moments/<编号>.md     front matter：date；编号就是发出的日期和时刻，2026-10-05-1230
media/<图>.jpg        文章和动态里写成 ../media/<图>.jpg
about.md
```

仓库里的 `content/` 是种子：镜像按它构建，服务器上的内容仓库也从它开始。之后真正的内容在服务器上（`/srv/homepage-press/content`，一个 git 仓库），种子不会自动跟上。`now.md` 已经并进动态，成了第一条。

## 客户机里

| | |
|---|---|
| `blog` | 文章列表（人人可看） |
| `blog edit <名字>` | 写一篇：这台机器里的草稿，或者服务器上的草稿，或者已发布的文章，都没有就新建。编辑器关掉时草稿存到服务器上，图片一起送去 |
| `blog drafts` | 服务器上的草稿 |
| `blog publish <名字>` | 发布：`~/blog/<名字>.md` 随即出现，网页也有了 |
| `blog withdraw <名字>` | 撤下，变回草稿 |
| `moments` · `moments all` | 动态，最新的在前；默认十条 |
| `moments new` | 写一条，编辑器关掉时问一句就发出去 |
| `moments delete <编号>` | 删一条（编号补全得出来） |

编辑器默认是 Microsoft Edit（`edit`）；`set EDITOR nano` 换成 nano（只在这次访问里有效，页面刷新后又是 Edit）。名字只用小写字母、数字和横线，它也是网址的一部分。草稿、文章、动态的名字都能 Tab 补全。

## 图片

1. `drop`（或者把图片拖到页面上），图片出现在 `~/drop`；
2. 草稿里写 `![天空](../drop/sky.jpg)`，相对草稿所在的 `~/drafts/`，也可以写 `~/drop/sky.jpg`；
3. 存草稿时页面把图片读出来送给 press，草稿里的引用随之改成 `../media/<图>.jpg`。拖进来的文件刷新页面就没了，送到服务器的不会。

press 收到图片后：按 EXIF 摆正，**去掉其余全部 EXIF**（拍摄地点、设备），最宽 1600 像素，存成 JPEG，名字是原图哈希的前 12 位。发布之前它只在 press 自己的数据里；用到它的文章或动态发布时，才和它们一起进内容仓库（同一个提交）。

由它派生：

- 网页：480、960 和原宽三种 WebP，`srcset` 按屏幕选，标上宽高免得排版跳动；
- 客户机：最宽 960 的 JPEG，`~/media/` 里，用到才下载。终端里 `cat` 一篇带图的文章，图片就画在正文的宽度里，最高 18 行，下面是说明文字（md.awk 打印 iTerm2 的内联图片序列，页面用 `@xterm/addon-image` 画）。那个插件只认 PNG、JPEG 和 GIF，所以存的是 JPEG。

## 新内容怎么进到机器里（`src/content.ts`）

镜像构建时，`content/` 的索引（每个文件的路径和哈希，加上文章列表；索引的 id 随任何文件变化）记在 manifest 里。页面打开、机器恢复后，拿 `/content/index.json` 和它比：一样就什么都不做；不一样，就把**新增和改动的文件**作为「内容在别处」的 9p 文件铺进 `/.content/<n>/`，连同要删除的路径和新的文章列表，hostd 把它们挪到 `~` 里。文件的字节在客户机第一次读到时才从 `/content/files/<哈希>` 下载，和镜像自己的文件一样。发布、撤下、发动态之后，页面立即再比一次，所以写完马上就在 `~/blog`、`~/moments` 里。

## 网页

press 用和构建时同一套模板（`scripts/lib/blog.ts`）渲染文章页、列表、动态页（`/moments/`）和 RSS，样式表是线上那次构建的（从 Vite 的 `.vite/manifest.json` 里找）。nginx 优先给 press 渲染的，没有时退回构建出来的那份（`deploy/nginx.conf`）。新部署了站点要重启 press，让它换上新样式表的名字。

## press 的接口

见 `press/src/writing.ts` 开头。都要站长登录。

## 测试

- `npm test --prefix press`：真 git 仓库、真 sharp：草稿、图片的 EXIF 和隐私、各种宽度的副本、客户机的 JPEG、发布、修订、撤下、动态、拒绝没有标题或缺图的文章、提交历史。
- `npm run check:writing`（先 `npm run build`）：本机起 press，Chrome 登录后在客户机里拖进一张图、写一篇带图的文章、存草稿、发布、终端里画出图片、网页的 srcset、换一台刚恢复的机器照样有、发一条动态再删掉、撤下文章、登出后什么都写不了。

## 部署（.101）

```
/srv/homepage-press/
  content/   内容仓库（git），属主 1000；第一次从仓库的 content/ 复制过来，press 启动时自己 git init
  public/    press 渲染的东西，属主 1000；nginx 只读挂在 /srv/press
  data/      账号、草稿、未发布的图片
```

press 容器多挂三处：`content → /content`、`public → /public`，以及站点所在的目录 `/srv/homepage-demo → /deploy`（只读；挂上一级，因为每次部署都会换掉 `site`）。环境变量见 `deploy/press.env.example`。nginx 容器多挂 `/srv/homepage-press/public → /srv/press`（只读）。
