# TODO

按优先级排列。做完一项就从这里划掉，挪进 README 的说明里。

## 先做

1. **提交 git、推到远程**：仓库已初始化，但一次都没提交过；有了远程仓库，`.github/workflows/build.yml` 才会第一次真正跑起来。
2. **自动部署**：CI 现在只上传 `site` 构件。要接上发布：把 `dist/` 推到 .101 的 `/srv/homepage-demo/site`，再重启 `homepage-demo` 容器；或者换到某个托管平台。
3. **定最终域名**：`test-demo.arc.moe` 只是演示用名。定下来之后在构建里设 `SITE_URL`，RSS 才会生成绝对链接。
4. **替换占位内容**：`content/about.md` 里的简介、GitHub、邮箱；两篇示例文章（`markdown.md` 只是排版测试）；`content/now.md`。

## 功能缺口

5. **「动态」**：最早的需求之一，还没做。设想是 `~/moments`，`moments` 命令列出、`cat` 阅读，再加一个发布流程。
6. **内容和快照解耦**：现在每发一篇文章都要重建镜像和快照（约 30 秒）。动态这种更新频繁的内容，应该在开机时从服务器拉取，比如用 v86 的 `create_file` 写进客户机。
7. **继续瘦身首次加载**：现在约 6.1 MB（gzip 后），网速 135 KB/s 时要等约 47 秒。可以从快照里少预热一些页缓存，或者先显示静态内容。
8. **联网**：`net on` 经自建中继（[docs/relay.md](docs/relay.md)）已上线（.101，经现有 nginx），`ip a`、`curl`、`ping` 都能用。还没自动部署：中继镜像和站点都是手动发布（见第 2 项）。`net warp`（[docs/warp.md](docs/warp.md)）保留为试验，线上没有它的管道。

## 质量与兼容

9. **其他浏览器**：只在 Chrome（含手机模拟）上测过。Safari、iOS 真机、Firefox 都还没测。
10. **无障碍**：xterm.js 的读屏模式没开。现在读屏用户只能靠 `<noscript>` 列表和网页版文章。
11. **SEO**：还缺 `sitemap.xml` 和分享卡片（Open Graph 标签）。
12. **终端排版器**（`md.awk`）：代码没有语法高亮，不支持表格和图片。

## 可选

13. ⌘K 命令面板；动态实时推送（`tail -f moments`）；终端内显示图片（sixel）；aarch64 彩蛋模式；浅色主题。
14. **保存 fish 历史**：现在一刷新就没了，目前当作「刷新即复原」的设计，要不要保存再定。

## 运维

15. **.100 的 Caddyfile 里有明文 Cloudflare token**：建议轮换，并改成通过环境变量注入。
16. **v2in0 的 SSH 正被爆破**：sshd 因 MaxStartups 频繁丢连接。建议只允许密钥登录、加 fail2ban，或者限制 22 端口的来源。
