function workbench --description 'Switch to the workbench: compilers, runtimes, Neovim, Android tools'
    if __on_workbench
        echo '  This is the workbench already.'
        return
    end
    set_color brblack
    echo '  Powering down for the workbench: 768 MB'
    echo '  and a disk of toolchains — gcc, clang,'
    echo '  rust, go, python, node, nvim, adb and'
    echo '  fastboot. `home` comes back here.'
    set_color normal
    # A private escape sequence; the page powers this machine down and the
    # workbench up.
    printf '\e]7337;machine;workbench\a'
end
