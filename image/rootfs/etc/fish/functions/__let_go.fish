# Asks the page to let go of what it lent the guest (serial, ble, usb), and
# waits for its word that it has: whatever the state said before, from an
# ask that came to nothing, say, is no answer to this.
function __let_go --argument-names what
    echo waiting >/run/$what/state
    printf '\e]7337;%s;off\a' $what >/dev/tty
    set -l line waiting
    for i in (seq 50)
        read line </run/$what/state
        test "$line" != waiting; and break
        sleep 0.1
    end
    test "$line" = waiting; and echo off >/run/$what/state
end
