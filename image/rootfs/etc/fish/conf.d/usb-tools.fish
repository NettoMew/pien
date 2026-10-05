# The tools that talk to a USB device have one of the kinds they speak lent
# to the guest first, unless one is (__usb_device): the browser offers only
# devices of those kinds. Asked for help or a version, a tool needs none.
# Kinds are vvvv[:pppp], a vendor and maybe its product, or cc[/ss[/pp]], a
# class and maybe its subclass and protocol, in hex. adb and fastboot have
# functions of their own.
set -l tools \
    'dfu-util fe/01' # DFU, the class for firmware upgrades

for row in $tools
    set -l kinds (string split -n ' ' -- $row)
    set -l tool $kinds[1]
    set -e kinds[1]
    function $tool --inherit-variable tool --inherit-variable kinds --description "$tool, on a USB device of this computer's"
        if not set -q argv[1]; or string match -qr -- '^(-h|--help|-V|--version|help|version)$' $argv
            command $tool $argv
        else
            __usb_device $kinds; and command $tool $argv
        end
    end
end
