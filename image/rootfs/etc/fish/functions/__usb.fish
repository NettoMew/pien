# Makes sure a phone is attached for $tool, adb or fastboot. If none is, it
# asks the page around this terminal for one: the page takes a phone this
# site may use already, or has the browser offer the choice. Says why when
# there is none.
function __usb --argument-names tool
    read -l line </run/usb/$tool
    string match -q 'up *' -- $line; and return 0

    echo waiting >/run/usb/$tool
    # A private escape sequence; the page acts on it. The key that ran this
    # command is what lets the page ask the browser for a device. Straight to
    # the terminal: `adb devices | grep …` must not pipe it away.
    printf '\e]7337;usb;%s\a' $tool >/dev/tty
    # Picking the phone in the browser's list can take a while.
    for i in (seq 1200)
        read line </run/usb/$tool
        test "$line" != waiting; and break
        sleep 0.1
    end

    set -l dim (set_color brblack)
    set -l n (set_color normal)
    set -l state (string split ' ' -- $line)
    switch $state[1]
        case up
            echo $dim"  $state[3..] ($state[2]), on this computer's USB"$n >&2
            test $tool = adb; and echo $dim'  If the phone asks, allow USB debugging.'$n >&2
            return 0
        case down
            __usb_why $tool $state[2..]
        case '*'
            echo off >/run/usb/$tool
            echo '  No answer from the page.' >&2
    end
    return 1
end

function __usb_why --argument-names tool why
    set -l text "USB error ($argv[3..])."
    switch $why
        case unsupported
            set text 'This browser has no WebUSB: Chrome and Edge have it, on a computer or on Android.'
        case cancelled
            set text 'No phone was chosen.'
        case mode
            if test $tool = adb
                set text 'That phone is not offering adb: turn on USB debugging in its developer options.'
            else
                set text 'That phone is not in its bootloader: adb reboot bootloader.'
            end
        case busy
            set text "Something else on this computer has the phone, most likely its own adb: adb kill-server there, then try again."
        case gone
            set text 'The phone went away.'
        case off
            set text 'Let go of the phone.'
    end
    echo '  '$text >&2
end
