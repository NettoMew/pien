# Asks the page to let go of what it lent the guest (serial, ble), and waits
# until it has.
function __let_go --argument-names what
    printf '\e]7337;%s;off\a' $what >/dev/tty
    for i in (seq 25)
        read -l line </run/$what/state
        string match -q 'up *' -- $line; or break
        sleep 0.2
    end
end
