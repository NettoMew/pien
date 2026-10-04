function adb --wraps adb --description "Android Debug Bridge, to a phone on this computer's USB"
    # These never talk to a device.
    switch "$argv[1]"
        case '' version help --help --version keygen pubkey start-server kill-server disconnect
            command adb $argv
            return
    end
    __usb adb; or return 1
    # hostd introduces the phone to the adb server too; this makes sure the
    # server knows it, and has finished shaking hands with it, before the
    # command runs. A phone waiting for its owner to allow this computer
    # stays "unauthorized", and adb says so, as on any desk.
    command adb connect 127.0.0.1:6555 >/dev/null
    for i in (seq 50)
        command adb -s 127.0.0.1:6555 get-state 2>&1 | string match -qr 'offline|connecting|authorizing'
        or break
        sleep 0.1
    end
    command adb $argv
end
