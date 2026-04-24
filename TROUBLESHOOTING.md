# Troubleshooting

This document captures common local issues and fixes for MusicGPT + NCM API.

## 1) `NCM_COOKIE` configured but still not logged in

### Symptoms
- `npm run ncm:check` fails with:
  - `profile.userId is missing`
  - `account is anonymous`
  - `account status is -10`

### Root cause
- Cookie is placeholder/expired/anonymous session.
- QR login returned a cookie string that is not fully usable yet.

### Fix
1. Ensure NCM API is reachable:
   - `npm run dev:ncm`
2. Re-login with QR:
   - `npm run ncm:cookie`
3. Validate immediately:
   - `npm run ncm:check`

Notes:
- Use NetEase Cloud Music app to confirm login.
- Do not commit real `NCM_COOKIE` to git.

## 2) `EADDRINUSE: address already in use :::3001`

### Symptoms
- Running `npm run dev:ncm` throws `EADDRINUSE`.

### Root cause
- Port `3001` is already occupied (often by an existing NCM API process).

### Fix
- Current script already handles this:
  - If a healthy NCM API is already on `http://127.0.0.1:3001`, it reuses it and exits normally.
- If port is occupied by another process:
  1. stop the conflicting process, or
  2. set a different `NCM_PORT` and `NCM_BASE_URL`.

## 3) QR login prints `Login confirmed` but validation still fails

### Symptoms
- `Login confirmed.`
- then `Cookie validation failed...`

### Root cause
- NCM API variant may return different `/login/qr/check` payload shape.
- Login state can lag for a few seconds after confirmation.

### Fix
- Use latest project scripts (already hardened):
  - cookie normalization
  - compatible QR payload parsing
  - retry validation via both:
    - `/login/status`
    - `/user/account`
- Retry once:
  - `npm run ncm:cookie`
  - `npm run ncm:check`

## 4) Quick health checklist

Run these checks in order:
1. `npm run dev:ncm`
2. `npm run ncm:check`
3. `npm run dev:full`
4. Health endpoints:
   - `http://127.0.0.1:3001/login/status`
   - `http://127.0.0.1:8787/health`

