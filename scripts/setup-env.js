#!/usr/bin/env node
/**
 * Generates development environment files with secure random secrets.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const backendEnv = path.join(root, 'backend', '.env');
const frontendEnv = path.join(root, 'frontend', '.env');

function secret() {
  return crypto.randomBytes(48).toString('hex');
}

if (!fs.existsSync(backendEnv)) {
  const content = `NODE_ENV=development
PORT=5050
MONGODB_URI=mongodb://localhost:27017/pulse
JWT_ACCESS_SECRET=${secret()}
JWT_REFRESH_SECRET=${secret()}
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
CLIENT_URL=http://localhost:5173
API_URL=http://localhost:5050
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
UPLOAD_DIR=${path.join(root, 'uploads')}
MAX_FILE_SIZE=52428800
COOKIE_SECURE=false
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=500
AUTH_RATE_LIMIT_MAX=50
# Malware scan (optional for local dev). Docker Compose sets this automatically.
# MALWARE_SCAN_CMD=${path.join(root, 'backend/scripts/malware-scan.sh')}
# MALWARE_SCAN_FAIL_CLOSED=false
# CLAMD_HOST=127.0.0.1
# CLAMD_PORT=3310
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=Pulse <noreply@pulse.app>
`;
  fs.writeFileSync(backendEnv, content);
  console.log('Created backend/.env');
} else {
  console.log('backend/.env already exists — skipped');
}

if (!fs.existsSync(frontendEnv)) {
  fs.writeFileSync(
    frontendEnv,
    `VITE_API_URL=http://localhost:5050
VITE_SOCKET_URL=http://localhost:5050
`
  );
  console.log('Created frontend/.env');
} else {
  console.log('frontend/.env already exists — skipped');
}

console.log('Environment setup complete.');
