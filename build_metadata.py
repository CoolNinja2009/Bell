# Build identity shared by local PlatformIO builds and GitHub Actions builds.
# UTC makes timestamp comparisons unambiguous across the dashboard and ESP32.
Import("env")

import datetime
import os

stamp = os.environ.get("FIRMWARE_BUILD_STAMP")
if not stamp:
    stamp = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

env.Append(CPPDEFINES=[("FIRMWARE_BUILD_STAMP", '\\"%s\\"' % stamp)])
print("[build_metadata] Firmware compilation timestamp: %s" % stamp)
