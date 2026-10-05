function __on_workbench --description 'Whether this is the workbench: its toolchain disk is in'
    mountpoint -q /run/toolchain
end
