function serial --description "A serial port on this computer, wired or over Bluetooth: serial | serial --uuid <UUID> | serial off"
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$argv[1]"
        case '' --uuid
            if test "$argv[1]" = --uuid; and not string match -qr '^[0-9A-Fa-f-]{4,36}$' -- "$argv[2]"
                echo 'serial: usage: serial --uuid <the RFCOMM service'"'"'s UUID>' >&2
                return 1
            end
            set -l device (__serial_device $argv[2]); or return 1
            read -l line </run/serial/state
            set -l state (string split ' ' -- $line)
            echo '  '$hl$device$n"  $state[3..]"
            if test $device = /dev/rfcomm0
                echo $dim"  tio $device · serial off"$n
            else
                echo $dim"  tio -b 115200 $device · serial off"$n
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
            echo 'serial: usage: serial [--uuid <UUID> | off]' >&2
            return 1
    end
end
