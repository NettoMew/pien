# The tools that talk to a serial port go through the one lent to the guest,
# and have one lent first if there is none (__serial_device). Each is told of
# it in its own way, unless it was given a port already, or needs none.

# tio: as its last argument.
function tio --description "A terminal for a serial port: the one lent to the guest, unless given another"
    if string match -qr -- '^(/dev/|-[lhva]$|--(list|help|version|auto-connect|complete))' $argv
        command tio $argv
    else
        set -l device (__serial_device); or return 1
        command tio $argv $device
    end
end

# stm32flash: as its last argument too. Alone, it shows its help.
function stm32flash --description "Flash an STM32 through its ROM bootloader, on the serial port lent to the guest"
    if not set -q argv[1]; or string match -qr -- '^(/dev/|-h$)' $argv
        command stm32flash $argv
    else
        set -l device (__serial_device); or return 1
        command stm32flash $argv $device
    end
end

# avrdude: as -P, for its programmers at the end of a serial line (those
# avrdude.conf gives connection_type = serial, as of avrdude 8.1).
function avrdude --description "Program an AVR, through the serial port or a USB programmer lent to the guest"
    set -l given $argv
    argparse --ignore-unknown 'c=' 'p=' 'P=' -- $argv 2>/dev/null
    set -l serial wiring arduino urclock xbee serialupdi serprog avrisp avrispv2 buspirate buspirate_bb \
        stk500 stk500v1 arduino_as_isp mib510 stk500v2 scratchmonkey stk500pp scratchmonkey_pp stk500hvsp \
        scratchmonkey_hvsp avr910 butterfly avr109 avr911 butterfly_mk mkbutterfly jtagmkI jtag1 pavr ponyser \
        dasa dasa3 c2n232i jtag2updi nanoevery
    # Asked which programmers or parts there are, it needs none.
    if __needs_no_device $given; or not set -q _flag_c; or string match -qr -- '\?' $_flag_c $_flag_p
        command avrdude $given
    else if contains -- $_flag_c $serial
        if set -q _flag_P
            command avrdude $given
        else
            set -l device (__serial_device); or return 1
            command avrdude -P $device $given
        end
    else
        # Its other programmers are on USB: lent as any USB tool's device
        # (usb-tools.fish), of the vendors avrdude.conf names for them.
        __usb_device 03eb 0403 04d8 1209 1457 16c0 16d0 1781 1a86 2341 2a03; and command avrdude $given
    end
end

# esptool and espefuse: from the environment, as ESPTOOL_PORT. esptool's
# commands on image files alone need no chip; nor does espefuse --virt.
for tool in esptool espefuse esptool.py espefuse.py
    function $tool --inherit-variable tool --description "Espressif's $tool, on the serial port lent to the guest"
        if set -q ESPTOOL_PORT; or not set -q argv[1]
            or string match -qr -- '^(-p|--port|-h$|--help|version$|elf2image$|merge[-_]bin$|image[-_]info$|--virt$)' $argv
            command $tool $argv
        else
            set -lx ESPTOOL_PORT (__serial_device); or return 1
            command $tool $argv
        end
    end
end

# mpremote: by its own connect, ahead of the rest, unless it was told of a
# port (connect, or a shortcut such as u0) or asked for no board at all.
function mpremote --description "MicroPython's remote control, on the serial port lent to the guest"
    if string match -qr -- '^(connect|devs|version|help|--help|-h|[acum][0-9])$' "$argv[1]"
        command mpremote $argv
    else
        set -l device (__serial_device); or return 1
        command mpremote connect $device $argv
    end
end

# lrzsz's: on their standard input and output, when those are the terminal.
for tool in sz sx sb rz rx rb
    function $tool --inherit-variable tool --description "lrzsz's $tool, over the serial port lent to the guest"
        if not isatty stdin; or not isatty stdout; or string match -qr -- '^(-h|--help|--version)$' $argv
            command $tool $argv
        else
            set -l device (__serial_device); or return 1
            command $tool $argv <$device >$device
        end
    end
end
