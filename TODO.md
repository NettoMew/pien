# TODO

按优先级排列。做完一项就从这里划掉，挪进 README 的说明里。

## 先做

1. **自动部署**：现在全靠手动。站点是 `SITE_URL=https://arc.moe npm run build`，把 `dist/` 换到 dmit.nrt 的 `/srv/homepage-demo/site`（旧的留成 `site.bak-<时间>`），再重启 `homepage-demo` 和 `homepage-press`；中继和 press 的镜像也是在 v2in0 上构建、手动装上的。CI 只上传 `site` 构件，还没接上发布。
2. **替换占位内容**：`content/about.md` 里的简介、GitHub、邮箱还是方括号里的占位；两篇示例文章（`markdown.md` 只是排版测试）。改种子要重建镜像，服务器上的内容仓库也要一起改。

## 接真设备试一遍

串口、蓝牙、USB 到现在只在假设备上测过（`check:serial`、`check:ble`、`check:usb`），每一台都像真的一样回答，但终究不是真的。

3. **USB**：一台真手机走 adb 和 fastboot，进出 bootloader 时重新借；Windows 上换 WinUSB 驱动的那一套（[docs/usb.md](docs/usb.md)）；联发科的 boot ROM 是 CDC ACM 设备，电脑自己的驱动会先占住它；瑞芯微、全志、树莓派的 BOOTSEL 各试一台。
4. **蓝牙 LE**：Nordic UART 和 HM-10 之外的四种（CH9141、Microchip Transparent UART、Ezurio VSP、u-blox SPS）是照厂商的资料和例子写的，还没在真模块上连过；一次写 20 字节在真链路上有多快，也还没量。
5. **经典蓝牙**：HC-05 在电脑和 Android 上的 Chrome 里各连一次，走远再回来。

## 功能缺口

6. **USB 复位传不到真设备**：Linux 自己的 USB/IP 也这样，复位只在客户机这一侧。不会自己 detach 的 DFU 设备、靠复位进 bootloader 的工具因此用不了。可以从客户机重新枚举时发的请求里认出复位，在页面上调 `device.reset()`。
7. **CMSIS-DAP v1 这类走 HID 的设备借不到**：WebUSB 不给 HID。可以另走 WebHID，把 HID 报告交给客户机。
8. **`share` 只是共享那一刻的样子**：之后在电脑上对文件夹的改动，客户机看不到，要再 `share` 一次；可以用 Chromium 的 `FileSystemObserver` 跟着改。写回文件夹失败时（磁盘满了、权限被收回）只在浏览器的控制台里记一笔，客户机不知道。
9. **继续瘦身首次加载**：现在约 7.1 MB（压缩后，快照占 6.2 MB），网速 135 KB/s 时要等约 53 秒。可以从快照里少预热一些页缓存，或者先显示静态内容。

## 质量与兼容

10. **其他浏览器**：页面和机器只在 Chrome（含手机模拟）上测过。Safari、iOS 真机、Firefox 都还没测；设备那几样本来就只有 Chromium 有（README 里的浏览器表）。
11. **无障碍**：xterm.js 的读屏模式没开。现在读屏用户只能靠 `<noscript>` 列表和网页版文章。
12. **SEO**：还缺 `sitemap.xml` 和分享卡片（Open Graph 标签）。
13. **终端排版器**（`md.awk`）：代码没有语法高亮，不支持表格。

## 可选

14. ⌘K 命令面板；动态实时推送（`tail -f moments`）；aarch64 彩蛋模式；浅色主题。
15. **保存 fish 历史**：现在一刷新就没了，目前当作「刷新即复原」的设计，要不要保存再定。
16. **edl 的 loader**：各家手机的 firehose 程序在另一个仓库，几百 MB，不随镜像，现在要访客自己拖进来。可以像 mtkclient 的 loader 那样按需读，放在站点上。

## 运维

17. **.100 的 Caddyfile 里有明文 Cloudflare token**：建议轮换，并改成通过环境变量注入。
18. **收掉香港的旧部署**：站点 2026-10-06 搬到了 dmit.nrt。.101 上停着的三个容器和 `/srv/homepage-*`、.100 上 arc.moe 那段 Caddy 配置都还留着，备回滚；确认不用了就删。`www.arc.moe`、`test-demo.arc.moe` 仍指向 .100，只做跳转，可以改成在 Cloudflare 上跳转，.100 就不必再管。
19. **v2in0 的 SSH 正被爆破**：sshd 因 MaxStartups 频繁丢连接。建议只允许密钥登录、加 fail2ban，或者限制 22 端口的来源。
