function fish_greeting
    # The greeting is recorded once, at build time, and replayed to every
    # visitor at whatever width they have — so no line is wider than a phone.
    set -l b (set_color --bold E7E9EE)
    set -l hl (set_color 4DE8FF)
    set -l dim (set_color 7E8590)
    set -l n (set_color normal)

    set -l mem (math -s0 (string match -rg 'MemTotal:\s+(\d+)' < /proc/meminfo) / 1024)
    set -l alpine (string split -f1,2 . (cat /etc/alpine-release) | string join .)
    set -l kernel (uname -r | string split -f1,2 . | string join .)
    set -l fish (string split -f1,2 . $version | string join .)

    echo
    echo '  '$b'From pixels to registers.'$n
    echo
    echo '  这是一台真正的 Linux，'
    echo '  此刻就运行在你的浏览器里。'
    echo '  '$dim(uname -m)" · Alpine $alpine · fish $fish"$n
    echo '  '$dim"Linux $kernel · $mem MB 内存"$n
    echo
    echo '  文章在 '$hl'~/blog'$n'，读到才下载。'
    echo '  试试  '$hl'ls -l blog'$n
    echo '        '$hl'cat blog/hello.md'$n
    echo '        '$hl'help'$n
    echo
end
