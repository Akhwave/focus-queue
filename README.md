# Focus Queue

Task, event and habit tracker. Ranks open tasks by importance, deadline and ease.
Runs in the browser (no build step). Data lives in your browser; the optional sync Worker keeps two devices equal.

- App: `index.html`, `app.js`, `style.css`, `sw.js` (hosted on GitHub Pages)
- Sync server: `worker/` (Cloudflare Worker + Durable Object, free plan)
- Tests: `node test-merge.js`

## Deploy the sync server (once)

```
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put TOKEN      # paste a long random key
```

Then in the app: Settings -> Sync address = your `https://focus-sync.<you>.workers.dev`, Sync key = the TOKEN.
Use "Copy phone link" and open it on the phone.

`ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the sites allowed to call the Worker.
