# Asks the page to lend the guest a device of the visitor's (serial, ble,
# usb), with what follows for the page to go by, and prints the state it
# settles in: "up …" or "down <why>". The page answers through hostd, in
# /run/<what>/state. A serial port or a BLE device is one of a kind: one lent
# already is the one, unasked. --again asks all the same, as for USB, where
# what is lent may not be the kind wanted.
function __lend
    argparse again -- $argv; or return 1
    set -l what $argv[1]
    read -l line </run/$what/state
    if set -q _flag_again; or not string match -q 'up *' -- $line
        echo waiting >/run/$what/state
        # A private escape sequence: the page asks the browser for the device,
        # which the key that ran this lets it do, or else a tap on the key the
        # screen offers. Straight to the terminal, so no pipe takes it.
        printf '\e]7337;%s;open;%s\a' $what "$argv[2]" >/dev/tty
        for i in (seq 3000)
            read line </run/$what/state
            test "$line" != waiting; and break
            sleep 0.1
        end
        test "$line" = waiting; and echo off >/run/$what/state
    end
    string match -qr '^(up|down) ' -- $line; or set line 'down silent'
    echo $line
end
