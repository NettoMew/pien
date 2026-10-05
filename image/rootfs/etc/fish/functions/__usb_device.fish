# Makes sure a USB device of one of the kinds given is lent to the guest,
# asking the page for one if none is: each kind is vvvv[:pppp], a vendor and
# maybe its product, or cc[/ss[/pp]], a class and maybe its subclass and
# protocol, in hex; none, for any device. Says so when it lends one, and why
# when there is none.
function __usb_device
    set -l before (cat /run/usb/1 /run/usb/2 /run/usb/3)
    set -l state (string split ' ' -- (__lend --again usb "$argv"))
    if test $state[1] != up
        __usb_why $state[2..]
        return 1
    end
    contains -- "up $state[3..]" $before
    or echo (set_color brblack)"  $state[4..], on this computer's USB"(set_color normal) >&2
end

function __usb_why --argument-names why
    set -l text "USB error ($argv[2..])."
    switch $why
        case unsupported
            set text 'This browser has no WebUSB: Chrome and Edge have it, on a computer and on Android.'
        case invalid
            set text 'Not a kind of USB device: <vendor>[:<product>] or <class>[/<subclass>[/<protocol>]], in hex.'
        case cancelled
            set text 'No device was chosen.'
        case busy
            set text 'Something else on this computer has the device, its own adb perhaps, or a driver that is not WinUSB: close it there, then try again.'
        case full
            set text 'Three devices are lent already: usb off lets go of them.'
        case gone
            set text 'The device went away.'
        case silent
            set text 'No answer from the page.'
        case off
            set text 'Let go of the devices.'
    end
    echo '  '$text >&2
end
