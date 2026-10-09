# Trả dần mỗi ngày — setup (about 15 minutes)

Your new site will be **https://tra-no.emile-cao.workers.dev**. It's free on Cloudflare's and GitHub's free plans, and it's separate from The Way.

## What's in this zip (upload all of it to GitHub)

```
wrangler.jsonc      site name + database link (paste your Database ID here)
worker.js           the server: roles, pending/confirm, link key, PIN lockout
public/tra-no.html  the app (one self-contained file)
public/sw.js        lets the app open without internet
src/ + build.mjs    source parts (only needed if the app is changed later)
```

## 1. Create the database
Cloudflare → **Storage & Databases → D1 SQL Database → Create**
- Name: `tra-no-db`
- Copy its **Database ID**.

## 2. Create the GitHub repository
1. Create a **new private** repository, e.g. `tra-no-site`.
2. Upload everything in this zip, with `wrangler.jsonc` at the top level, not inside a folder.
3. In `wrangler.jsonc`, replace `PASTE-YOUR-DATABASE-ID-HERE` with the ID and keep the quotes. Commit.

## 3. Create the Worker
Cloudflare → **Workers & Pages → Create → Import a repository** → pick `tra-no-site`.
- Project name: **`tra-no`** (it must match `"name"` in `wrangler.jsonc`).
- Keep the deploy command `npx wrangler deploy`. Deploy.

## 4. Set your admin PIN
Worker `tra-no` → **Settings → Runtime variables and secrets → Add**
- Type: **Secret**
- Name: `ADMIN_PIN`
- Value: your 4–8 digits

Don't use the "Variables and secrets" under **Build**. The running site can't see those.

## 5. Check it works
Open `https://tra-no.emile-cao.workers.dev/api/data`
- `{"error":"auth"}` means everything is set up correctly.
- `{"error":"setup", ...}` names what's missing: the database link or the PIN.

## 6. First use (you, Mẫn)
1. Open `https://tra-no.emile-cao.workers.dev` in Chrome, enter your PIN, and tap **Đăng nhập quản lý**.
2. Go to ⚙ **Cài đặt → Nhập file…**, choose `debt-tracker-backup-2026-10-09.json`, then tap **Gộp**.
   You should see *Anh Trường còn nợ 9.957.000đ*.
3. In Chrome's menu, tap **Add to Home screen**.

## 7. Send anh Trường his link
Go to ⚙ **Cài đặt → Gửi link** and send it through Zalo. He opens it once in Chrome and adds it to his Home screen. He doesn't need a PIN.
- Everything he logs arrives as **Chờ xác nhận**. Only you can tap ✓ or ✕.
- If the link leaks, tap **Đổi link** (tap twice). The old link stops working, and you send him the new one.

## Good to know
- Both phones update automatically: when the app opens, every 30 seconds, and right after any change. Offline changes wait on the phone and send themselves later.
- The dot next to ⚙ shows sync status: green = synced, orange = syncing, grey = offline, red = a problem (tap it to see what).
- After 6 wrong PINs from one place, the site pauses for 15 minutes.
- Back up from time to time: ⚙ → **Xuất file**. Settings shows how many changes were made since your last backup.
