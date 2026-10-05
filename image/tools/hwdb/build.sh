#!/bin/sh
# udev's hardware database, for USB alone: lsusb names devices by it, and
# usbutils has no other list of them. Built from eudev's own sources of it,
# as `udevadm hwdb --update` builds it wherever udev runs.

set -eu

apk add --no-cache eudev eudev-hwids > /dev/null
mkdir -p /hwdb/etc/udev/hwdb.d
cp /usr/lib/udev/hwdb.d/20-usb-classes.hwdb /usr/lib/udev/hwdb.d/20-usb-vendor-model.hwdb /hwdb/etc/udev/hwdb.d/
udevadm hwdb --update --root=/hwdb
install -D -m 444 /hwdb/etc/udev/hwdb.bin "$OUT/etc/udev/hwdb.bin"
echo "hwdb: $(wc -c < "$OUT/etc/udev/hwdb.bin") bytes, USB alone"
