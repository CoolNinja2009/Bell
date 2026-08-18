#include "time_fmt.h"
#include <stdio.h>
#include <string.h>

// 0 = YYYY-MM-DD, 1 = DD-MM-YYYY (Indian default), 2 = MM-DD-YYYY
static uint8_t g_date_order = 1;
static bool    g_time_seconds = true;

void time_fmt_set(const char* date_format, const char* time_format) {
    if (date_format) {
        if (strcmp(date_format, "yyyy-mm-dd") == 0)      g_date_order = 0;
        else if (strcmp(date_format, "mm-dd-yyyy") == 0) g_date_order = 2;
        else                                             g_date_order = 1;
    }
    if (time_format) {
        g_time_seconds = (strcmp(time_format, "hh:mm") != 0);
    }
}

void time_fmt_date(char* buf, size_t size, const struct tm* t) {
    const int y = t->tm_year + 1900;
    const int m = t->tm_mon + 1;
    const int d = t->tm_mday;
    if (g_date_order == 0)      snprintf(buf, size, "%04d-%02d-%02d", y, m, d);
    else if (g_date_order == 2) snprintf(buf, size, "%02d-%02d-%04d", m, d, y);
    else                        snprintf(buf, size, "%02d-%02d-%04d", d, m, y);
}

void time_fmt_time(char* buf, size_t size, const struct tm* t) {
    if (g_time_seconds) snprintf(buf, size, "%02d:%02d:%02d", t->tm_hour, t->tm_min, t->tm_sec);
    else                snprintf(buf, size, "%02d:%02d", t->tm_hour, t->tm_min);
}

void time_fmt_datetime(char* buf, size_t size, const struct tm* t) {
    char d[16];
    char tm[16];
    time_fmt_date(d, sizeof(d), t);
    time_fmt_time(tm, sizeof(tm), t);
    snprintf(buf, size, "%s %s", d, tm);
}
