module.exports = {
  apps: [
    {
      name: "telebox",
      script: "scripts/run-tsx.cjs",
      args: "./src/index.ts",
      cwd: "/root/telebox_mtcute",
      interpreter: "/root/.nvm/versions/node/v24.15.0/bin/node",
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
