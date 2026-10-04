function home --description 'Switch back to the home machine'
    if not __on_workbench
        echo '  This is the home machine already.'
        return
    end
    set_color brblack
    echo '  Powering down for the home machine.'
    set_color normal
    printf '\e]7337;machine;home\a'
end
