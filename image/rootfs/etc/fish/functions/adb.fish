function adb --wraps adb --description "Android Debug Bridge, to a phone on this computer's USB"
    # These never talk to a phone.
    switch "$argv[1]"
        case '' version help --help --version keygen pubkey start-server kill-server connect disconnect
            command adb $argv
            return
    end
    __usb_device ff/42/01; or return 1
    # adb's server finds a phone on USB a moment after it is plugged in, and
    # then shakes hands with it: this waits until it has, so the command
    # finds it. A phone waiting for its owner to allow this computer stays
    # "unauthorized", and adb says so, as on any desk.
    for i in (seq 50)
        command adb devices 2>/dev/null | string match -qr '\t(device|unauthorized|recovery|rescue|sideload)$'; and break
        sleep 0.1
    end
    command adb $argv
end
