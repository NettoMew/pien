function ble --description "A Bluetooth LE serial device, as /dev/ttyBLE0: ble | ble --uuid <service> | ble off"
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$argv[1]"
        case '' --uuid
            if test "$argv[1]" = --uuid; and test -z "$argv[2]"
                echo 'ble: usage: ble --uuid <the serial service'"'"'s UUID>' >&2
                return 1
            end
            set -l state (string split ' ' -- (__lend ble $argv[2]))
            if test $state[1] != up
                __ble_why $state[2..]
                return 1
            end
            echo '  '$hl$state[2]$n"  $state[3..]"
            echo $dim"  tio $state[2] · ble off"$n
        case off
            __let_go ble
            echo $dim'  Let go.'$n
        case '*'
            echo 'ble: usage: ble [--uuid <UUID> | off]' >&2
            return 1
    end
end

function __ble_why --argument-names why
    set -l text "Bluetooth error ($argv[2..])."
    switch $why
        case unsupported
            set text 'This browser has no Web Bluetooth: Chrome and Edge have it, on a computer and on Android.'
        case unavailable
            set text 'Bluetooth is off here, or there is none.'
        case invalid
            set text 'Not a Bluetooth UUID: 16 or 32 bits in hex, or all 128.'
        case cancelled
            set text 'No device was chosen.'
        case unknown
            set text 'The device has no serial service known here: ble --uuid <its service> names one.'
        case missing
            set text "The device has no service $argv[2]."
        case silent
            set text 'No answer from the page.'
        case off
            set text 'Let go of the device.'
    end
    echo '  '$text >&2
end
