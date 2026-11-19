#!/usr/bin/env python3
"""Tambah izin + deklarasi foreground service ke AndroidManifest.xml (idempotent)."""
import re
import sys

path = sys.argv[1]
xml = open(path, encoding="utf-8").read()

perms = [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
]
add = "".join(
    f'    <uses-permission android:name="{p}" />\n'
    for p in perms
    if f'android:name="{p}"' not in xml
)
if add:
    m = re.search(r"\n\s*<application", xml)
    if not m:
        sys.exit("ERROR: tag <application> tidak ditemukan di manifest")
    xml = xml[: m.start()] + "\n" + add.rstrip("\n") + xml[m.start():]

if ".BgService" not in xml:
    service = (
        '        <service android:name=".BgService" android:exported="false" '
        'android:foregroundServiceType="dataSync" />\n'
    )
    if "</application>" not in xml:
        sys.exit("ERROR: </application> tidak ditemukan di manifest")
    xml = xml.replace("</application>", service + "    </application>", 1)

open(path, "w", encoding="utf-8").write(xml)
for needle in perms + ["BgService"]:
    if needle not in xml:
        sys.exit(f"ERROR: '{needle}' gagal ditambahkan")
print("Manifest OK")
