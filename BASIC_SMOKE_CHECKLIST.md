# Basic Function Smoke Checklist

Branch: `codex/test-basic-20260424`
Baseline: `main`

## Automated Checks
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run typecheck`

## Manual Smoke Checks
- [ ] Home page loads without console/runtime error
- [ ] Login flow works (enter -> success/failure feedback)
- [ ] Key navigation routes are reachable
- [ ] Core submission flow works end to end
- [ ] Error states show user-friendly messages

## Issue Severity
- Blocker: core flow unavailable or app cannot run
- High: major user journey broken with no workaround
- Medium: partial degradation with workaround
- Low: minor UI/copy/edge issue

## Commit Convention (Test Branch)
Use `test:` prefix for test-only commits, for example:
- `test: add smoke checklist`
- `test: record home/login smoke results`
- `test: add regression case for api chat error`
