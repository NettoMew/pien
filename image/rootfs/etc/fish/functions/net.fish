function net --description 'The network: net on | off | login | relay | passkey | github'
    set -l verb $argv[1]
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    read -l line </run/net/state
    set -l state (string split ' ' -- $line)

    switch "$verb"
        case on
            if test "$state[1]" = up
                __net_up $state[2..3]
                return
            end
            set state (__net_ask on)
            if test "$state[1]" = down -a "$state[2]" = login
                # This site's relay takes its owner's login: log in, then go on.
                net login; or return 1
                set state (__net_ask on)
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
            if test "$argv[2]" = github
                echo $dim'  Log in with GitHub, in the window that opens …'$n
            else
                echo $dim'  Log in with your passkey …'$n
            end
            set -l until (__ask net login $argv[2]); or return 1
            echo '  '$hl'Logged in'$n', until '$until'.'
        case logout
            __ask net logout; or return 1
            echo $dim'  Logged out.'$n
        case passkey passkeys
            __net_passkey $argv[2..]
        case github
            echo $dim'  Sign in to GitHub, in the window that opens …'$n
            set -l account (__ask net github); or return 1
            echo '  '$hl$account$n' on GitHub logs in here now: net login github.'
        case relay
            __net_relay $argv[2..]
        case ''
            if test "$state[1]" = up
                echo '  '$hl'Online'$n' through the relay, at '(string join ' and ' $state[3] (__net_ipv6))
            else
                echo '  Offline.'
            end
            set -l facts (__ask net status)
            set -l relay (string replace -rf '^relay\t' '' -- $facts)
            set -l until (string replace -rf '^login\t' '' -- $facts)
            if test "$relay" = site
                echo $dim"  Relay: this site's, for its owner."$n
            else
                echo $dim'  Relay: '$relay$n
            end
            if test "$until" = -
                echo $dim'  Not logged in.'$n
            else
                echo $dim'  Logged in until '$until'.'$n
            end
            echo $dim'  net on · net off · net login · net relay · net passkey'$n
        case '*'
            echo 'net: usage: net [on | off | login [github] | logout | relay | passkey | github]' >&2
            return 1
    end
end

# Asks the page for a way out, then waits for hostd to say how it went.
# Prints the new state, word by word.
function __net_ask --argument-names verb
    echo waiting >/run/net/state
    # A private escape sequence; the page around this terminal acts on it.
    # On stderr: stdout is what the caller captures.
    printf '\e]7337;net;%s\a' $verb >&2
    echo (set_color brblack)'  Connecting through the relay …'(set_color normal) >&2
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

function __net_up --argument-names way address
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    echo '  '$hl'Online'$n' through the relay, at '(string join ' and ' $address (__net_ipv6 --wait))
    # Ask Cloudflare which way out this took.
    set -l trace (curl -s --max-time 15 https://1.1.1.1/cdn-cgi/trace)
    set -l ip (string replace -rf '^ip=' '' -- $trace)
    set -l colo (string replace -rf '^colo=' '' -- $trace)
    set -q ip[1]; and echo '  Out via '$ip' · '$colo
    echo $dim'  Try curl wttr.in/?0 · ping 1.1.1.1'$n
    echo $dim'      ssh user@host · mtr 1.1.1.1'$n
end

# The IPv6 address the guest made from the relay's advertisement, if it made
# one. With --wait, the advertisement has a second to come: it follows a
# moment after eth0 comes up.
function __net_ipv6
    argparse wait -- $argv; or return
    set -l tries 1
    set -q _flag_wait; and set tries 10
    for i in (seq $tries)
        set -l address (ip -6 addr show dev eth0 scope global 2>/dev/null | string match -rg 'inet6 ([0-9a-f:]+)/')
        if set -q address[1]
            echo $address[1]
            return
        end
        test $i -lt $tries; and sleep 0.1
    end
    return 1
end

function __net_why
    set -l why "Network error ($argv)."
    switch "$argv[1]"
        case login
            set why "This site's relay is its owner's: net login first."
        case badlogin
            set why 'The relay did not take this login: net login again.'
        case nokey
            set why 'Your relay needs its key: net relay <address> to give it.'
        case badkey
            set why 'The relay did not take its key: net relay <address> to give it again.'
        case busy
            set why 'The relay is busy. Try again in a while.'
        case quota
            set why 'This session has used up its traffic.'
        case idle
            set why 'Quiet for too long, so the relay hung up. net on to come back.'
        case norelay
            set why 'Cannot reach the relay.'
        case timeout
            set why 'No answer: the connection is gone.'
        case closed
            set why 'The connection closed.'
        case off
            set why 'Off.'
    end
    echo '  '$why >&2
    echo (set_color brblack)'  Offline, there is still: blog · help'(set_color normal) >&2
end

# The passkeys that log in to this site: listed, added, removed.
function __net_passkey --argument-names action
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$action"
        case ''
            set -l rows (__ask net passkeys); or return 1
            echo
            for row in $rows
                set -l field (string split \t -- $row)
                if test $field[1] = github
                    echo
                    if test $field[2] = -
                        echo $dim'  GitHub: not linked (net github)'$n
                    else
                        echo $dim'  GitHub: '$n$field[2]$dim' (net login github)'$n
                    end
                else
                    set -l used $field[4]
                    test $used = -; and set used never
                    echo '  '$hl$field[1]$n'  '$field[2]$dim'  made '$field[3]', last used '$used$n
                end
            end
            echo
            echo $dim'  net passkey add [name] · net passkey remove <n>'$n
        case add
            set -l name (string join ' ' -- $argv[2..])
            echo $dim'  Make a passkey for this site, in the browser …'$n
            set -l added (__ask net passkey add "$name")
            set -l got $status
            if test $got -eq 3
                echo '  The first passkey takes a one-time code from the server'
                echo '  itself: docker exec homepage-press press enroll'
                read -l -P '  Code: ' code; or return 1
                set added (__ask net passkey add "$name" "$code")
                set got $status
            end
            test $got -eq 0; or return 1
            echo '  '$hl'Added'$n' '$added[1]'.'
            set -l until (string replace -rf '^login\t' '' -- $added)
            set -q until[1]; and echo $dim'  Logged in until '$until'.'$n
        case remove
            set -l name (__ask net passkey remove $argv[2]); or return 1
            echo $dim'  Removed '$n$name$dim'.'$n
        case '*'
            echo 'net: usage: net passkey [add [name] | remove <n>]' >&2
            return 1
    end
end

# The relay `net on` goes through: this site's, or one of your own.
function __net_relay --argument-names address
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$address"
        case ''
            set -l relay (__ask net relay); or return 1
            if test "$relay" = site
                echo "  Through this site's relay, for its owner."
            else
                echo '  Through '$hl$relay$n
            end
            echo $dim'  net relay <address>: through a relay of your own (docs/relay.md)'$n
            echo $dim"  net relay reset: back to this site's"$n
        case reset
            __ask net relay reset >/dev/null; or return 1
            echo "  Through this site's relay from now on."
        case '*'
            set -l url (__ask net relay $address)
            set -l got $status
            if test $got -eq 3
                read -l -s -P '  Its key, as `relay key` printed it: ' key; or return 1
                echo
                set url (__ask net relay $address $key)
                set got $status
            end
            test $got -eq 0; or return 1
            echo '  Through '$hl$url$n' from now on.'
            read -l line </run/net/state
            string match -q 'up *' -- $line; and echo $dim'  Still online the old way: net off, then net on.'$n
    end
end
