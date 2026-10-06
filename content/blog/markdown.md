---
title: 排版样例
date: 2026-10-01
tags: [meta]
---

这是一篇用来检查终端排版的样例文章。正文是 **加粗**、*斜体*、`行内代码` 与[链接](https://example.com)混排的一段话，中文和 English 混在一起时，折行应该依然整齐，不会把一个汉字劈成两半。

## 列表

1. 有序列表的第一项
2. 第二项，稍微长一点，长到需要折行的时候，续行应该和上一行的文字对齐
3. 第三项

- 无序列表
- 嵌套之前的最后一项

## 表格

| 命令 | 做什么 | 用时 |
|---|---|--:|
| `net on` | 经中继联网，拿到一个自己的 IPv6 地址 | 2.3 秒 |
| `cat` 一篇文章 | 在终端里排版，表格和代码都在内 | 即时 |
| `take` | 把机器里的文件存到电脑上 | 1 秒 |

## 代码

```c
static int __init curious_init(void)
{
	pr_info("hello from %s\n", "guest");
	return 0;
}
```

```fish
function hello --description 'say hi'
    echo "hello from $hostname" # fish knows where it runs
end
```

## 引用

> 好奇心就是调度器。
