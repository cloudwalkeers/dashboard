# Getting `IG_USER_ID` + `IG_ACCESS_TOKEN` (your own account)

Because gptmarlon is **your own** account, you can use **standard access** — no App Review,
no "advanced access". The whole thing is done from the Graph API Explorer in ~10 minutes.

## 0. Prerequisites (one-time)
- The Instagram account must be a **Professional** account (Business or Creator):
  Instagram app → Settings → *Account type and tools* → Switch to professional.
- It must be **linked to a Facebook Page**: Instagram app → Settings → *Account type and
  tools* → *Connect a Facebook Page* (create a throwaway Page if you don't have one).
  The classic Instagram Graph API (what this project uses, `graph.facebook.com`) needs the
  Page link — that's how it finds the `instagram_business_account` id.

## 1. Create the app
- developers.facebook.com → **My Apps → Create App**.
- Use case: pick **Other → Business** (the "Business" app type). If it shows a use-case
  picker, choose whichever includes Instagram; you can add the product after.
- Create it. You don't need to fill in privacy URLs etc. for your own-account testing.

## 2. (optional) Add the Instagram product
- App dashboard → *Add product* → **Instagram** (the Graph API one, not "Basic Display"
  which is deprecated). This isn't strictly required for the Explorer path but keeps the
  app tidy.

## 3. Generate a token in Graph API Explorer
- developers.facebook.com/tools/explorer
- Top-right: select **your app**.
- *Generate Access Token* → choose a **User Token**.
- Add these permissions (Permissions dropdown), then regenerate:
  - `instagram_basic`
  - `instagram_manage_insights`
  - `pages_show_list`
  - `pages_read_engagement`
  - `business_management` (only if it won't list your Page without it)
- Click **Generate Access Token**, log in, and **grant** access to the gptmarlon page/account.
  You now have a **short-lived** user token (~1 hour).

## 4. Find your `IG_USER_ID`
In the Explorer query bar, run:
```
me/accounts?fields=name,instagram_business_account{id,username}
```
Your gptmarlon Page row will show `instagram_business_account.id` — **that number is
`IG_USER_ID`** (it is NOT your @handle and NOT the Page id).

## 5. Exchange for a long-lived token (~60 days)
Open this URL in a browser (fill in the three values — App ID/Secret are in
*App settings → Basic*):
```
https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN
```
The JSON response's `access_token` is your long-lived **`IG_ACCESS_TOKEN`**.

## 6. Put them in `.env`
```
IG_USER_ID=17841400000000000
IG_ACCESS_TOKEN=EAAG...long...token
```
(You can keep `GRAPH_VERSION=v21.0`.) Then:
```
npm run backfill --days 21    # backfill the last 3 weeks
```

## Renewal
Long-lived tokens last ~60 days. Re-run step 5 with the current token as
`fb_exchange_token` to refresh it before it expires (we can automate this later).

## Quick sanity check
Once set, the dashboard server prints `Mode: LIVE Instagram data` on start, and
`me/accounts?...` in the Explorer should show your reels under
`instagram_business_account`.
