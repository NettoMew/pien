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
                    echo '  No answer after a minute; giving up.' >&2
                    return 1
            end
        case off
            printf '\e]7337;net;off\a'
            # hostd takes the address away a moment later; wait for it, so
            # that whatever runs next finds the network gone.
            for i in (seq 25)
                read line </run/net/state
                string match -q 'up *' -- $line; or break
                sleep 0.2
            end
            echo $dim'  Off.'$n
        case login
            __net_login
        case logout
            printf '\e]7337;net;logout\a'
            echo $dim'  Forgot the relay password.'$n
        case forget
            printf '\e]7337;net;forget\a'
            echo $dim"  Deleted this browser's WARP device."$n
        case ''
            if test "$state[1]" = up
                echo '  '$hl'Online'$n' through '(__net_name $state[2])', at '$state[3]
            else
                echo '  Offline.'
            end
            echo $dim'  net on · net off · net login'$n
            echo $dim'  net warp: via Cloudflare WARP (experimental)'$n
        case '*'
            echo 'net: usage: net [on | off | login | logout | warp | forget]' >&2
            return 1
    end
end

function __net_name --argument-names way
    if test "$way" = warp
        echo Cloudflare WARP
    else
        echo the relay
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
    echo (set_color 7E8590)'  Connecting through '(__net_name $way)' …'(set_color normal) >&2
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
    read -l -s -P '  Relay password: ' password; or return 1
    test -n "$password"; or return 1
    printf '\e]7337;net;login;%s\a' (string escape --style=url -- $password)
    echo (set_color 7E8590)'  Kept in this browser, as a key made from it.'(set_color normal)
end

function __net_consent
    set -l dim (set_color 7E8590)
    set -l n (set_color normal)
    echo
    echo '  net warp puts this machine on'
    echo '  Cloudflare WARP, with an'
    echo '  unofficial client.'
    echo $dim
    echo '  · The first time, it registers an'
    echo '    anonymous device; its key stays'
    echo '    in your browser.'
    echo '  · Traffic goes through this site to'
    echo '    Cloudflare. The site sees only'
    echo '    encrypted bytes; it also passes'
    echo '    on the registration.'
    echo '  · Not a Cloudflare service: it may'
    echo '    stop working at any time.'
    echo "  · Going on accepts Cloudflare's terms:"
    echo '    https://www.cloudflare.com/application/terms/'$n
    echo
    read -l -P '  Go on? [y/N] ' answer
    string match -qi y -- $answer
end

function __net_up --argument-names way address
    set -l dim (set_color 7E8590)
    set -l hl (set_color 4DE8FF)
    set -l n (set_color normal)
    echo '  '$hl'Online'$n' through '(__net_name $way)', at '$address
    # Ask Cloudflare which way out this took.
    set -l trace (curl -s --max-time 15 https://1.1.1.1/cdn-cgi/trace)
    set -l ip (string replace -rf '^ip=' '' -- $trace)
    set -l colo (string replace -rf '^colo=' '' -- $trace)
    set -q ip[1]; and echo '  Out via '$ip' · '$colo
    echo $dim'  Try curl wttr.in/?0 · ping 1.1.1.1'$n
    echo $dim'      ssh user@host · mtr 1.1.1.1'$n
end

function __net_why
    set -l why "Network error ($argv)."
    switch "$argv[1]"
        case nokey
            set why 'The relay needs its password: net login.'
        case badkey
            set why 'The relay did not take that password: net login to try again.'
        case busy
            set why 'The relay is busy. Try again in a while.'
        case quota
            set why 'This session has used up its traffic.'
        case idle
            set why 'Quiet for too long, so the relay hung up. net on to come back.'
        case norelay
            set why 'Cannot reach the relay.'
        case api
            set why 'Could not register a WARP device. Try again later.'
            test "$argv[2]" = 429; and set why 'Too many registrations. Wait a while.'
        case pipe
            set why "Cannot reach this site's WARP pipe."
        case denied
            set why 'Cloudflare no longer knows this device, so it is gone: net warp registers a new one.'
        case pin
            set why "The WARP edge's key is not the one it should be. Stopped."
        case refused
            set why "WARP refused the connection (HTTP $argv[2])."
        case timeout
            set why 'No answer: the connection is gone.'
        case closed
            set why 'The connection closed.'
        case off
            set why 'Off.'
        case device
            set why 'The saved device is broken: net forget, then try again.'
    end
    echo '  '$why >&2
    echo (set_color 7E8590)'  Offline, there is still: blog · help'(set_color normal) >&2
end
