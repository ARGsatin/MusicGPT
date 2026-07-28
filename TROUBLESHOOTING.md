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
- Current supervisor already handles this:
  - If a healthy NCM API is already on `http://127.0.0.1:3001`, it reuses and monitors it.
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
1. On Windows, double-click `一键启动.cmd` (recommended).
2. Or run `npm run dev:full`; it performs ordered readiness and login checks.
3. For isolated diagnosis, run `npm run dev:ncm`, then `npm run ncm:check`.
4. Health endpoints:
   - `http://127.0.0.1:3001/login/status`
   - `http://127.0.0.1:8787/health`

## 5) NCM import error meanings

- `ncm_unreachable`: the local NCM API is down or unreachable; the one-click launcher repairs this state.
- `ncm_cookie_missing`: `.env` has no usable Cookie; QR login starts during full startup.
- `ncm_not_logged_in`: the account is anonymous or the login expired; refresh it with `npm run ncm:cookie`.
- `ncm_likes_empty`: login works, but the account has no liked songs to import.
- `ncm_track_details_empty`: liked IDs were returned but NCM returned no track metadata; restart the pinned API and retry.

Transient `/likelist` failures are retried and never replace a valid Cookie. QR recovery is reserved for explicit authentication failures.

