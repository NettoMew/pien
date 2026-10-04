function net --description 'The network: net on | net off | net login | net warp' --argument-names verb
    set -l dim (set_color 7E8590)
    set -l hl (set_color 4DE8FF)
    set -l n (set_color normal)
    read -l line </run/net/state
    set -l state (string split ' ' -- $line)

    switch "$verb"
        case on warp
            set -l way relay
            test $verb = warp; and set way warp
            if test "$state[1]" = up -a "$state[2]" = $way
                __net_up $state[2..3]
                return
            end
            if test $way = warp; and not test -e /run/net/known; and not __net_consent
                return 1
            end
            set state (__net_ask $verb)
            if test "$state[1]" = down -a "$state[2]" = nokey
                __net_login; or return 1
                set state (__net_ask $verb)
            end
            switch $state[1]
                case up
                    __net_up $state[2..3]
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
        case login
            __net_login
        case logout
            printf '\e]7337;net;logout\a'
            echo $dim'  已忘掉中继口令。'$n
        case forget
            printf '\e]7337;net;forget\a'
            echo $dim'  已删除这个浏览器里的 WARP 设备。'$n
        case ''
            if test "$state[1]" = up
                echo '  '$hl'已接入'$n' '(__net_name $state[2])'，地址 '$state[3]
            else
                echo '  没有联网。'
            end
            echo $dim'  net on 接入 · net off 断开 · net login 输入口令'$n
            echo $dim'  net warp 改走 Cloudflare WARP（试验）'$n
        case '*'
            echo 'net: 用法 net [on | off | login | logout | warp | forget]' >&2
            return 1
    end
end

function __net_name --argument-names way
    if test "$way" = warp
        echo Cloudflare WARP
    else
        echo 中继
    end
end

# Asks the page for a way out, then waits for hostd to say how it went.
# Prints the new state, word by word.
function __net_ask --argument-names verb
    echo waiting >/run/net/state
    # A private escape sequence; the page around this terminal acts on it.
    # On stderr: stdout is what the caller captures.
    printf '\e]7337;net;%s\a' $verb >&2
    set -l way relay
    test $verb = warp; and set way warp
    echo (set_color 7E8590)'  正在接入'(__net_name $way)' …'(set_color normal) >&2
    for i in (seq 300)
        read -l line </run/net/state
        if test "$line" != waiting
            string split ' ' -- $line
            return
        end
        sleep 0.2
    end
    echo timeout
end

function __net_login
    read -l -s -P '  中继口令：' password; or return 1
    test -n "$password"; or return 1
    printf '\e]7337;net;login;%s\a' (string escape --style=url -- $password)
    echo (set_color 7E8590)'  记住了，只在这个浏览器里，而且只存由它算出的密钥。'(set_color normal)
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

function __net_up --argument-names way address
    set -l dim (set_color 7E8590)
    set -l hl (set_color 4DE8FF)
    set -l n (set_color normal)
    echo '  '$hl'已接入'$n' '(__net_name $way)'，地址 '$address
    # Ask Cloudflare which way out this took.
    set -l trace (curl -s --max-time 15 https://1.1.1.1/cdn-cgi/trace)
    set -l ip (string replace -rf '^ip=' '' -- $trace)
    set -l colo (string replace -rf '^colo=' '' -- $trace)
    set -q ip[1]; and echo '  出口 '$ip' · 节点 '$colo
    echo $dim'  试试 curl wttr.in/?0 · ping 1.1.1.1 · ssh 用户@主机'$n
end

function __net_why
    set -l why "联网出错（$argv）。"
    switch "$argv[1]"
        case nokey
            set why '中继要口令：net login。'
        case badkey
            set why '中继不认这个口令：net login 重新输入。'
        case busy
            set why '中继正忙，稍后再试。'
        case quota
            set why '这次会话的流量额度用完了。'
        case idle
            set why '太久没动静，中继先断开了；net on 再连。'
        case norelay
            set why '连不上中继。'
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
            set why '对方没有回应，连接断了。'
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
