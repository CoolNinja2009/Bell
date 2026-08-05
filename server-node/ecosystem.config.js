/**
 * ecosystem.config.js — PM2 process configuration for the relay controller server.
 * ─────────────────────────────────────────────────────────────────────
 * Usage:
 *   pm2 start ecosystem.config.js        # start
 *   pm2 restart ecosystem.config.js      # restart (updater uses this)
 *   pm2 stop ecosystem.config.js         # stop
 *   pm2 logs relay-server                # view logs
 */
module.exports = {
  apps: [
    {
      name: 'relay-server',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      // PM2 native log rotation
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'pm2-error.log',
      out_file: 'pm2-out.log',
      merge_logs: true,
      // Wait before considering the process "online"
      listen_timeout: 10000,
      // Kill timeout on stop/restart (ms)
      kill_timeout: 5000,
    },
  ],
};
