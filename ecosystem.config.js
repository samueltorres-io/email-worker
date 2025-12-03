module.exports = {
  apps : [{
    name   : "email-worker",
    script : "./index.js",
    max_memory_restart: '100M',
    env: {
      NODE_ENV: "production",
      REDIS_PASS: "",
      SMTP_USER: "",
      SMTP_PASS: ""
    }
  }]
}

// pm2 start ecosystem.config.js
// node index.js --retry-dlq