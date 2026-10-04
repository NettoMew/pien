function net --description 'The network: net warp | net off | net forget' --argument-names verb
    set -l dim (set_color 7E8590)
    set -l hl (set_color 4DE8FF)
    set -l n (set_color normal)
    read -l line </run/net/state
    set -l state (string split ' ' -- $line)

    switch "$verb"
        case warp
            if test "$state[1]" = up
                __net_up $state[2]
                return
            end
            if not test -e /run/net/known; and not __net_consent
                return 1
            end
            echo waiting >/run/net/state
            # A private escape sequence; the page around this terminal acts on
            # it, and tells hostd how it went (see hostd).
            printf '\e]7337;net;warp\a'
            echo $dim'  正在接入 Cloudflare WARP …'$n
            for i in (seq 300)
                read line </run/net/state
                set state (string split ' ' -- $line)
                test "$state[1]" = waiting; or break
                sleep 0.2
            end
            switch $state[1]
                case up
                    __net_up $state[2]
                case down
                    __net_why $state[2..]
                    return 1
                case '*'
                    echo '  等了一分钟还没接上，先放弃。' >&2
                    return 1
            end
        case off
            printf '\e]7337;net;off\a'
            echo $dim'  已断开。'$n
        case forget
            printf '\e]7337;net;forget\a'
            echo $dim'  已删除这个浏览器里的 WARP 设备。'$n
        case ''
            if test "$state[1]" = up
                echo '  '$hl'已接入'$n' Cloudflare WARP，地址 '$state[2]
            else
                echo '  没有联网。'
            end
            echo $dim'  net warp 接入 · net off 断开'$n
            echo $dim'  net forget 删除 WARP 设备'$n
        case '*'
            echo 'net: 用法 net [warp | off | forget]' >&2
            return 1
    end
end

function __net_consent
    set -l dim (set_color 7E8590)
    set -l n (set_color normal)
    echo
    echo '  net warp 用一个非官方客户端，'
    echo '  把这台机器接入 Cloudflare WARP。'
    echo $dim
    echo '  · 第一次用会为你匿名注册一个设备，'
    echo '    密钥只存在你的浏览器里。'
    echo '  · 流量经本站转发给 Cloudflare，本站'
    echo '    只看得到加密的字节；注册请求也经'
    echo '    本站转发。'
    echo '  · 这不是 Cloudflare 的官方服务，'
    echo '    随时可能失效。'
    echo '  · 继续即表示接受 Cloudflare 的条款：'
    echo '    https://www.cloudflare.com/application/terms/'$n
    echo
    read -l -P '  继续吗？[y/N] ' answer
    string match -qi y -- $answer
end

function __net_up --argument-names address
    set -l dim (set_color 7E8590)
    set -l hl (set_color 4DE8FF)
    set -l n (set_color normal)
    echo '  '$hl'已接入'$n' Cloudflare WARP，地址 '$address
    # Ask Cloudflare which way out this took.
    set -l trace (curl -s --max-time 15 https://1.1.1.1/cdn-cgi/trace)
    set -l ip (string replace -rf '^ip=' '' -- $trace)
    set -l colo (string replace -rf '^colo=' '' -- $trace)
    set -q ip[1]; and echo '  出口 '$ip' · 节点 '$colo
    echo $dim'  试试 curl wttr.in/?0 · ping 1.1.1.1'$n
end

function __net_why
    set -l why "和 WARP 的连接出错（$argv）。"
    switch "$argv[1]"
        case api
            set why '没能注册 WARP 设备，稍后再试。'
            test "$argv[2]" = 429; and set why '注册得太频繁了，过一会儿再试。'
        case pipe
            set why '连不上本站的 WARP 中转。'
        case denied
            set why 'Cloudflare 不认这个设备了，已经清掉；再敲一次 net warp 会重新注册。'
        case pin
            set why 'WARP 入口的公钥对不上，已中止。'
        case refused
            set why "WARP 拒绝了连接（HTTP $argv[2]）。"
        case timeout
            set why 'WARP 没有回应，连接断了。'
        case closed
            set why '连接断了。'
        case off
            set why '已断开。'
        case device
            set why '保存的设备信息坏了：net forget 之后再试。'
    end
    echo '  '$why >&2
    echo (set_color 7E8590)'  不联网也能逛：blog · help'(set_color normal) >&2
end
