#pragma once

#include <Arduino.h>

constexpr size_t BELL_SERIAL_LOG_LINE_BYTES = 192;
constexpr uint8_t BELL_SERIAL_LOG_CAPACITY = 96;

// Mirrors the existing USB Serial output into a bounded, thread-safe line
// buffer. Network delivery happens separately on core 0.
class BellSerialMirror : public Print {
public:
    void begin(unsigned long baud);
    void flush();
    size_t write(uint8_t byte) override;
    using Print::write;
};

extern BellSerialMirror bell_serial;

// Copy up to max_lines without removing them. Call discard after the server
// accepts the batch, so a brief server outage does not lose diagnostics.
uint8_t bell_serial_peek_logs(char (*lines)[BELL_SERIAL_LOG_LINE_BYTES], uint8_t max_lines);
void bell_serial_discard_logs(uint8_t count);
