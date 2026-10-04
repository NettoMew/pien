function help --description 'What this machine can do'
    set -l rows \
        'ls  cd  tree  grep' '都是真命令，随便用' \
        blog '文章列表' \
        'cat 文章.md' '排版后阅读' \
        'open 文章.md' '在浏览器里读网页版' \
        'fastfetch  htop' '看看这台机器' \
        'net on' '接入互联网，然后 curl、ping、ssh'

    echo
    set -l hl (set_color 4DE8FF)
    set -l dim (set_color 7E8590)
    set -l n (set_color normal)
    for i in (seq 1 2 (count $rows))
        set -l about $rows[(math $i + 1)]
        if test $COLUMNS -lt 60 # a phone: one above the other
            printf '  %s%s%s\n  %s%s%s\n' $hl $rows[$i] $n $dim $about $n
        else
            printf '  %s%s%s  %s\n' $hl (string pad -r -w 18 -- $rows[$i]) $n $about
        end
    end
    echo
    set_color 7E8590
    echo '  文件第一次被读到时才下载，'
    echo '  留意页面底部。'
    echo '  一切只在你的浏览器里，'
    echo '  随便折腾，刷新即复原。'
    set_color normal
    echo
end
