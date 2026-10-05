# The device of the port lent to the guest, lending one first if there is
# none: one of an RFCOMM service of its own if a UUID is given. For `serial`,
# and for the tools that want a port.
function __serial_device --argument-names service
    read -l line </run/serial/state
    if not string match -q 'up *' -- $line
        echo waiting >/run/serial/state
        # A private escape sequence: the page asks the browser for a port,
        # which the key that ran this lets it do, or else a tap on the key
        # the screen offers. Straight to the terminal, so no pipe takes it.
        printf '\e]7337;serial;open;%s\a' $service >/dev/tty
        for i in (seq 3000)
            read line </run/serial/state
            test "$line" != waiting; and break
            sleep 0.1
        end
    end
    set -l state (string split ' ' -- $line)
    switch $state[1]
        case up
            echo $state[2]
        case down
            __serial_why $state[2..]
            return 1
        case '*'
            echo off >/run/serial/state
            echo '  No answer from the page.' >&2
            return 1
    end
end

function __serial_why --argument-names why
    set -l text "Serial error ($argv[2..])."
    switch $why
        case unsupported
            set text 'This browser has no Web Serial: Chrome and Edge have it on a computer, and Chrome on Android for Bluetooth.'
        case cancelled
            set text 'No port was chosen.'
        case busy
            set text 'Something else on this computer has the port open: close it there, then try again.'
        case gone
            set text 'The port went away.'
        case off
            set text 'Let go of the port.'
    end
    echo '  '$text >&2
end
