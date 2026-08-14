#include "bell_logger.h"

#include <freertos/FreeRTOS.h>

BellSerialMirror bell_serial;

static portMUX_TYPE g_log_lock = portMUX_INITIALIZER_UNLOCKED;
static char g_lines[BELL_SERIAL_LOG_CAPACITY][BELL_SERIAL_LOG_LINE_BYTES];
static uint8_t g_write_index = 0;
static uint8_t g_read_index = 0;
static char g_current_line[BELL_SERIAL_LOG_LINE_BYTES];
static size_t g_current_length = 0;

static void commit_current_line_locked() {
    if (g_current_length == 0) return;

    g_current_line[g_current_length] = '\0';
    strncpy(g_lines[g_write_index], g_current_line, BELL_SERIAL_LOG_LINE_BYTES - 1);
    g_lines[g_write_index][BELL_SERIAL_LOG_LINE_BYTES - 1] = '\0';

    const uint8_t next = (g_write_index + 1) % BELL_SERIAL_LOG_CAPACITY;
    if (next == g_read_index) {
        // Keep the newest diagnostics when the server has been offline long enough
        // to fill the bounded buffer.
        g_read_index = (g_read_index + 1) % BELL_SERIAL_LOG_CAPACITY;
    }
    g_write_index = next;
    g_current_length = 0;
}

void BellSerialMirror::begin(unsigned long baud) {
    ::Serial.begin(baud);
}

void BellSerialMirror::flush() {
    ::Serial.flush();
}

size_t BellSerialMirror::write(uint8_t byte) {
    const size_t written = ::Serial.write(byte);

    portENTER_CRITICAL(&g_log_lock);
    if (byte == '\n') {
        commit_current_line_locked();
    } else if (byte != '\r') {
        if (g_current_length >= BELL_SERIAL_LOG_LINE_BYTES - 1) {
            commit_current_line_locked();
        }
        g_current_line[g_current_length++] = static_cast<char>(byte);
    }
    portEXIT_CRITICAL(&g_log_lock);
    return written;
}

uint8_t bell_serial_peek_logs(char (*lines)[BELL_SERIAL_LOG_LINE_BYTES], uint8_t max_lines) {
    if (!lines || max_lines == 0) return 0;

    portENTER_CRITICAL(&g_log_lock);
    uint8_t count = 0;
    uint8_t index = g_read_index;
    while (index != g_write_index && count < max_lines) {
        strncpy(lines[count], g_lines[index], BELL_SERIAL_LOG_LINE_BYTES - 1);
        lines[count][BELL_SERIAL_LOG_LINE_BYTES - 1] = '\0';
        index = (index + 1) % BELL_SERIAL_LOG_CAPACITY;
        ++count;
    }
    portEXIT_CRITICAL(&g_log_lock);
    return count;
}

void bell_serial_discard_logs(uint8_t count) {
    portENTER_CRITICAL(&g_log_lock);
    while (count-- && g_read_index != g_write_index) {
        g_read_index = (g_read_index + 1) % BELL_SERIAL_LOG_CAPACITY;
    }
    portEXIT_CRITICAL(&g_log_lock);
}
