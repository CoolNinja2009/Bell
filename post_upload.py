# post_upload.py — erases otadata after every USB upload to force the
# ESP32 bootloader to boot from the factory partition.
#
# Without this, OTA-updated ESP32s silently boot old firmware from
# ota_0/ota_1 even after you flash factory. You'll see "Beacon: ...
# (fallback 192.168.1.100:8080)" and wonder why your changes didn't
# take. This script prevents that.
Import("env")

def after_upload(source, target, env):
    import subprocess, os

    # Use the port that was just used for upload
    port = env.subst("$UPLOAD_PORT")
    if not port:
        print("[post_upload] WARNING: no UPLOAD_PORT — skipping otadata erase")
        return

    # Find esptool.py from the PlatformIO packages directory
    esptool = None
    pio_packages = os.path.join(os.path.expanduser("~"), ".platformio", "packages")
    for root, dirs, files in os.walk(pio_packages):
        if "esptool.py" in files and "tool-esptoolpy" in root:
            esptool = os.path.join(root, "esptool.py")
            break
    if not esptool:
        # fallback: try system esptool
        esptool = "esptool.py"
    # Use PlatformIO's bundled Python (has pyserial — system Python may not)
    python_exe = env.subst("$PYTHONEXE")
    if not python_exe:
        python_exe = "python"

    cmd = f'"{python_exe}" "{esptool}" --port {port} erase_region 0xE000 0x2000'
    print(f"[post_upload] {cmd}")
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            print("[post_upload] otadata erased — ESP32 will boot factory")
        else:
            print(f"[post_upload] FAILED:\n{result.stderr}")
    except Exception as e:
        print(f"[post_upload] exception: {e}")

env.AddPostAction("upload", after_upload)
