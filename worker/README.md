# newbreak-costs-api — Worker backup

This folder is a version-controlled copy of the Cloudflare Worker (`newbreak-costs-api`)
that backs the dashboard in `../e18176716ee60c8f/index.html`. It lives in this repo so the
frontend and backend have one combined, durable history — the Worker itself isn't hosted
in git anywhere else.

## Deploying

```bash
./deploy.sh
```

Requires a Cloudflare API token at `~/.config/cloudflare/token.env`
(`CLOUDFLARE_API_TOKEN=...`). Deploys `worker.js` with the bindings declared in
`metadata.json` — **always deploy through this script** (or include the same
`bindings` array) rather than a bare API call, or the KV namespace / ALLOWED_ORIGIN
binding gets silently dropped and the whole site breaks (CORS + KV reads fail).

Account id and KV namespace id are in `metadata.json` (not secret). The API token and
the NewsBreak account secrets (`NEWSBREAK_TOKEN_*`, `ACCESS_KEY`, etc.) are Cloudflare
secrets, set outside of this repo, and survive redeploys automatically.

## Restoring from a backup tag

Each confirmed-stable snapshot of the whole project (this worker + the dashboard) is
tagged in this repo, e.g. `baseline-2026-10-01`. To roll back after a bad change:

```bash
git checkout <tag-name> -- worker/worker.js worker/metadata.json e18176716ee60c8f/index.html
cd worker && ./deploy.sh
cd .. && git add -A && git commit -m "Roll back to <tag-name>" && git push
```

That restores both the live dashboard page and the Worker to that tagged snapshot.
