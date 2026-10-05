function fastboot --wraps fastboot --description "Fastboot, to a phone in its bootloader on this computer's USB"
    switch "$argv[1]"
        case '' help -h --help --version
            command fastboot $argv
            return
    end
    __usb_device ff/42/03; or return 1
    command fastboot $argv
end
