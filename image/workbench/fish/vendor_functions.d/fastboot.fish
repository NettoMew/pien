function fastboot --wraps fastboot --description "Fastboot, to a phone in its bootloader on this computer's USB"
    switch "$argv[1]"
        case '' help -h --help --version
            command fastboot $argv
            return
    end
    __usb fastboot; or return 1
    # fastboot lists only the phones on its own USB; this one comes in over
    # the network, so the list is this one line.
    if test "$argv[1]" = devices
        read -l line </run/usb/fastboot
        printf '%s\tfastboot\n' (string split ' ' -- $line)[2]
        return
    end
    ANDROID_SERIAL=tcp:127.0.0.1:6554 command fastboot $argv
end
