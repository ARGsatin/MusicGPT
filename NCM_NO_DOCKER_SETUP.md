# NCM API Setup Without Docker

This project now supports running the Netease Cloud Music API locally via Node.js.

## 1) Configure `.env`

Edit `D:\MusicGPT\.env` and set:

```env
NCM_BASE_URL=http://127.0.0.1:3001
NCM_COOKIE=PASTE_FULL_NETEASE_COOKIE_HERE
OPENAI_API_KEY=
```

`NCM_COOKIE` should include at least `MUSIC_U`.

## 2) Auto-fetch cookie (recommended)

```bash
npm run ncm:cookie
```

What this command does:
- calls NCM QR login endpoints
- writes QR image to `D:\MusicGPT\.ncm-login-qr.png`
- waits for login confirmation on your phone
- overwrites `NCM_COOKIE` in `.env`
- verifies `/user/account` with the new cookie

Prerequisite: NCM API must already be running (`npm run dev:ncm`).

## 2.1) Validate cookie (recommended)

```bash
npm run ncm:check
```

This command verifies:
- `/login/status` with your `NCM_COOKIE`
- `/user/account` is non-anonymous (`profile.userId` exists)
- `/likelist` is reachable with your real uid

## 3) Start only NCM API

```bash
npm run dev:ncm
```

This runs `npx -y NeteaseCloudMusicApi@latest` with `PORT=3001`.

## 4) Start full stack

```bash
npm run dev:full
```

This starts:
- NCM API on `3001`
- MusicGPT server on `8787`
- MusicGPT web on `5173`

## 5) Health checks

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/login/status
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/health
```

If `/login/status` returns `code: 200`, the NCM API service is reachable.
