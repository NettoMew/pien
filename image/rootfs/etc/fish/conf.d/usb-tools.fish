# The tools that talk to a USB device have one of the kinds they speak lent
# to the guest first, unless one is (__usb_device), or the tool needs none
# (__needs_no_device): the browser offers only devices of those kinds. Kinds
# are vvvv[:pppp], a vendor and maybe its product, or cc[/ss[/pp]], a class
# and maybe its subclass and protocol, in hex. adb and fastboot have
# functions of their own; so has avrdude, whose programmers may be on a
# serial line instead (serial-tools.fish).
set -l tools \
    'dfu-util       fe/01' \
    'rkdeveloptool  2207' \
    'sunxi-fel      1f3a:efe8' \
    'picotool       2e8a' \
    'mtk            0e8d 1004:6000 22d9:0006 0fce' \
    'edl            05c6:9008 05c6:900e 05c6:9025 0fce 1199 0846:68e0 19d2:0076' \
    'openocd        0d28 2e8a 0483 1366 0403 303a 1a86 1fc9 c251 15ba' \
    'flashrom       1a86:5512 1a86:55db 1a86:55de 0403 0483:dada 1209:c0ca'
# dfu-util:      DFU, the class for firmware upgrades (STM32's boot ROM among them)
# rkdeveloptool: Rockchip, in Maskrom or its loader
# sunxi-fel:     Allwinner, in FEL
# picotool:      Raspberry Pi's RP2040 and RP2350, in BOOTSEL or running
# mtk:           MediaTek, in its boot ROM or preloader, as mtkclient knows them
# edl:           Qualcomm, in emergency download mode, as edl knows them
# openocd:       debug probes: DAPLink, Raspberry Pi's, ST-Link, J-Link, FTDI,
#                Espressif's, WCH-Link, NXP's, Keil's, Olimex's
# flashrom:      SPI flash programmers: CH341A, CH347, FTDI, Dediprog, DirtyJTAG

for row in $tools
    set -l kinds (string split -n ' ' -- $row)
    set -l tool $kinds[1]
    set -e kinds[1]
    function $tool --inherit-variable tool --inherit-variable kinds --description "$tool, on a USB device of this computer's"
        if __needs_no_device $argv
            command $tool $argv
        else
            __usb_device $kinds; and command $tool $argv
        end
    end
end
