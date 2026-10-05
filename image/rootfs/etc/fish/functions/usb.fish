function usb --description "USB devices on this computer, lent to the guest: usb | usb attach [<kind>…] | usb off"
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$argv[1]"
        case ''
            set -l lent
            for port in 1 2 3
                read -l line </run/usb/$port
                set -l state (string split ' ' -- $line)
                test "$state[1]" = up; or continue
                echo '  '$hl$state[2]$n"  $state[3..]"
                set -a lent $port
            end
            set -q lent[1]; or echo '  No USB device lent. usb attach asks for one, and so do the tools.'
            echo $dim'  lsusb · usb off: let go of them, for this computer'"'"'s own tools'$n
        case attach
            __usb_device $argv[2..]; or return 1
            read -l line </run/usb/state
            set -l state (string split ' ' -- $line)
            echo '  '$hl$state[3]$n"  $state[4..]"
        case off
            __let_go usb
            echo $dim'  Let go.'$n
        case '*'
            echo 'usb: usage: usb [attach [<vendor>[:<product>] | <class>[/<subclass>[/<protocol>]]]… | off]' >&2
            return 1
    end
end
