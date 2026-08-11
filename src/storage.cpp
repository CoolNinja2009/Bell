/*
 * storage.cpp  —  LittleFS Persistent Storage implementation
 */
#include "storage.h"
#include "bell_core.h"
#include<EaCy.h>

#include <LittleFS.h>

static bool s_mounted = false;

void storage_init() {
    // "littlefs" matches the partition label in partitions_ota.csv.
    // formatOnFail=true ensures the partition is usable on first boot.
    if (LittleFS.begin(true, "/littlefs", 10, "littlefs")) {
        s_mounted = true;
        char buf[80];
        snprintf(buf, sizeof(buf), "LittleFS mounted: %u / %u bytes used",
                 LittleFS.usedBytes(), LittleFS.totalBytes());
        bell_core_log(buf);
    } else {
        bell_core_log("LittleFS mount FAILED — storage unavailable");
    }
}

bool storage_ready() {
    return s_mounted;
}

size_t storage_total_bytes() {
    if (!s_mounted) return 0;
    return LittleFS.totalBytes();
}

size_t storage_used_bytes() {
    if (!s_mounted) return 0;
    return LittleFS.usedBytes();
}
