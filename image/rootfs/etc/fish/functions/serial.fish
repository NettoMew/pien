function serial --description "A serial port on this computer, as /dev/ttyUSB0: serial | serial off" --argument-names verb
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$verb"
        case ''
            read -l line </run/serial/state
            if not string match -q 'up *' -- $line
                echo waiting >/run/serial/state
                # A private escape sequence: the page asks the browser for a
                # port, which the key that ran this lets it do. Straight to the
                # terminal, so no pipe takes it away.
                printf '\e]7337;serial;open\a' >/dev/tty
                for i in (seq 1200)
                    read line </run/serial/state
                    test "$line" != waiting; and break
                    sleep 0.1
                end
            end
            set -l state (string split ' ' -- $line)
            switch $state[1]
                case up
                    echo '  '$hl'/dev/ttyUSB0'$n"  $state[2..]"
                    echo $dim'  tio -b 115200 /dev/ttyUSB0 · serial off'$n
                case down
                    __serial_why $state[2..]
                    return 1
                case '*'
                    echo off >/run/serial/state
                    echo '  No answer from the page.' >&2
                    return 1
            end
        case off
            printf '\e]7337;serial;off\a' >/dev/tty
            for i in (seq 25)
                read -l line </run/serial/state
                string match -q 'up *' -- $line; or break
                sleep 0.2
            end
            echo $dim'  Let go.'$n
        case '*'
            echo 'serial: usage: serial [off]' >&2
            return 1
    end
end

function __serial_why --argument-names why
    set -l text "Serial error ($argv[2..])."
    switch $why
        case unsupported
            set text 'This browser has no Web Serial: Chrome and Edge have it, on a computer.'
        case cancelled
            set text 'No port was chosen.'
        case activation
            set text 'The browser wants a key press before it lists ports: run it again.'
        case busy
            set text 'Something else on this computer has the port open: close it there, then try again.'
        case gone
            set text 'The port went away.'
        case off
            set text 'Let go of the port.'
    end
    echo '  '$text >&2
end
