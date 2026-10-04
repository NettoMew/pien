function usb --description "The phone on this computer's USB: usb | usb off" --argument-names verb
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$verb"
        case ''
            set -l attached
            for tool in adb fastboot
                read -l line </run/usb/$tool
                set -l state (string split ' ' -- $line)
                if test "$state[1]" = up
                    echo '  '$hl$tool$n"  $state[3..] ($state[2])"
                    set -a attached $tool
                end
            end
            if not set -q attached[1]
                echo '  No phone attached. adb or fastboot asks for one.'
            end
            echo $dim"  usb off: let go of it, for this computer's own tools"$n
        case off
            printf '\e]7337;usb;off\a'
            for i in (seq 25)
                cat /run/usb/adb /run/usb/fastboot | string match -q 'up *'; or break
                sleep 0.2
            end
            echo $dim'  Let go.'$n
        case '*'
            echo 'usb: usage: usb [off]' >&2
            return 1
    end
end
