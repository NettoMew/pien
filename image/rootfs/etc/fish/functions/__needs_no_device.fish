# Whether a tool asked this of needs no device lent: nothing asked, help
# asked for, a version alone (-v is flashrom's verify, among others), or a
# device named by its path.
function __needs_no_device
    not set -q argv[1]
    or string match -qr -- '^(-h|--help|help)$' $argv[1]
    or begin
        not set -q argv[2]
        and string match -qr -- '^(-v|-V|--version|version)$' $argv[1]
    end
    or string match -qr -- '^(/dev/|[^/]*=/dev/)' $argv
end
