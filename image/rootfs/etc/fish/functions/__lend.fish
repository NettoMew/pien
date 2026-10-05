# Asks the page to lend the guest a device of the visitor's (serial, ble),
# unless one is lent already, with what follows for the page to go by, and
# prints the state it settles in: "up <device> <name>" or "down <why>". The
# page answers through hostd, in /run/<what>/state.
function __lend --argument-names what
    read -l line </run/$what/state
    if not string match -q 'up *' -- $line
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
