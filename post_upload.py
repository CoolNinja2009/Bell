# post_upload.py — After every USB upload:
#   1. Write the host's current timestamp to the coredump partition (0x3B4000)
#      so the firmware can show "Uploaded at: <flash time>" — refreshed on
#      every upload, even when the binary itself is unchanged.
#   2. Erase the otadata partition so the bootloader falls back to factory.
#
# USB uploads always go to factory (golden image).
# OTA updates use the dual OTA partition rotation (ota_0 <-> ota_1) via the
# ESP-IDF esp_ota_set_boot_partition() API, and record their own upload time.
Import("env")

UPLOAD_TS_ADDR  = 0x3B4000  # coredump partition + 16 KB (past the coredump header)
UPLOAD_TS_MAGIC = 0x53545055  # "UPTS" (little-endian)
OTADATA_ADDR    = 0xE000
OTADATA_SIZE    = 0x2000


def _find_esptool():
    import os
    pio = os.path.join(os.path.expanduser("~"), ".platformio", "packages")
    for root, dirs, files in os.walk(pio):
        if "esptool.py" in files and "tool-esptoolpy" in root:
            return os.path.join(root, "esptool.py")
    return "esptool.py"


def _esptool(env, port, args, before="default_reset", after="hard_reset", timeout=30):
    import subprocess
    python_exe = env.subst("$PYTHONEXE") or "python"
    esptool = _find_esptool()
    cmd = [python_exe, esptool,
           "--chip", "esp32",
           "--before", before,
           "--after", after,
           "--port", port] + args
    print(f"[post_upload] {' '.join(cmd)}")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def after_upload(source, target, env):
    import os, struct, time, tempfile
    port = env.subst("$UPLOAD_PORT")
    if not port:
        print("[post_upload] WARNING: no UPLOAD_PORT — skipping")
        return

    # 8-byte marker: magic (uint32) + unix timestamp (uint32), little-endian.
    marker = struct.pack("<II", UPLOAD_TS_MAGIC, int(time.time()))
    marker_path = os.path.join(tempfile.gettempdir(), "upload_ts.bin")
    with open(marker_path, "wb") as f:
        f.write(marker)

    # 1. Write the timestamp (keep the chip in the bootloader stub).
    r = _esptool(env, port, ["write_flash", f"{UPLOAD_TS_ADDR:#x}", marker_path],
                 after="no_reset")
    if r.returncode != 0:
        print(f"[post_upload] timestamp write FAILED (continuing):\n{r.stderr}")

    # 2. Erase otadata → bootloader falls back to factory on reset.
    r = _esptool(env, port, ["erase_region", f"{OTADATA_ADDR:#x}", f"{OTADATA_SIZE:#x}"],
                 before="no_reset", after="hard_reset")
    if r.returncode == 0:
        print("[post_upload] otadata erased — ESP32 will boot factory")
    else:
        print(f"[post_upload] otadata erase FAILED:\n{r.stderr}")


env.AddPostAction("upload", after_upload)
