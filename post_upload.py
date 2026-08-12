# post_upload.py — After every USB upload, erase the otadata partition
# so the ESP32 bootloader falls back to the factory partition (which
# just received the new firmware).
#
# USB uploads always go to factory (golden image).
# OTA updates use the dual OTA partition rotation (ota_0 <-> ota_1)
# via the ESP-IDF esp_ota_set_boot_partition() API — which writes
# proper otadata with CRC/validation fields.
Import("env")


def _esptool(env, port, args, timeout=30):
    import subprocess
    python_exe = env.subst("$PYTHONEXE") or "python"
    esptool = _find_esptool()
    cmd = [python_exe, esptool,
           "--chip", "esp32",
           "--before", "default_reset",
           "--after", "hard_reset",
           "--port", port] + args
    print(f"[post_upload] {' '.join(cmd)}")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _find_esptool():
    import os
    pio = os.path.join(os.path.expanduser("~"), ".platformio", "packages")
    for root, dirs, files in os.walk(pio):
        if "esptool.py" in files and "tool-esptoolpy" in root:
            return os.path.join(root, "esptool.py")
    return "esptool.py"


def after_upload(source, target, env):
    port = env.subst("$UPLOAD_PORT")
    if not port:
        print("[post_upload] WARNING: no UPLOAD_PORT — skipping")
        return

    r = _esptool(env, port, ["erase_region", "0xE000", "0x2000"])
    if r.returncode == 0:
        print("[post_upload] otadata erased — ESP32 will boot factory")
    else:
        print(f"[post_upload] otadata erase FAILED:\n{r.stderr}")


env.AddPostAction("upload", after_upload)
