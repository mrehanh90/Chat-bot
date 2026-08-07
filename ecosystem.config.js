module.exports = {
  apps: [
    {
      name: 'whatsapp-assistant',
      script: './index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
      // Avoid a hot-restart crash loop if WhatsApp/OpenAI is briefly unreachable.
      min_uptime: '10s',
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
