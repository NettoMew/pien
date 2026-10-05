# The device of the port lent to the guest, lending one first if there is
# none: one with an RFCOMM service of its own if a UUID is given. For
# `serial`, and for the tools that want a port.
function __serial_device --argument-names service
    set -l state (string split ' ' -- (__lend serial $service))
    if test $state[1] = up
        echo $state[2]
    else
        __serial_why $state[2..]
        return 1
    end
end

function __serial_why --argument-names why
    set -l text "Serial error ($argv[2..])."
    switch $why
        case unsupported
            set text 'This browser has no Web Serial: Chrome and Edge have it on a computer, and Chrome on Android for Bluetooth.'
        case invalid
            set text 'Not a Bluetooth UUID: 16 or 32 bits in hex, or all 128.'
        case cancelled
            set text 'No port was chosen.'
        case busy
            set text 'Something else on this computer has the port open: close it there, then try again.'
        case gone
            set text 'The port went away.'
        case silent
            set text 'No answer from the page.'
        case off
            set text 'Let go of the port.'
    end
    echo '  '$text >&2
end
