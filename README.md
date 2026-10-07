# ProCare Media Downloader

Bulk-download your kids' photos and videos out of the ProCare parent portal.

Built for families with more than one child. Media is filed per child, and
pulled from **both** of ProCare's feeds — the activity timeline *and* the photo
gallery — because each one carries media the other misses.

## How to Use

1. **Log into ProCare in Google Chrome**
   Go to <https://schools.procareconnect.com> and sign in. The script reads your
   existing session, so it has to run in a tab that's already logged in.

2. **Open the DevTools Console**
   Press `F12` (or `Ctrl+Shift+J` / `Cmd+Option+J`) and click the **Console** tab.

3. **Paste the script**
   Copy the entire contents of [`index.js`](./index.js), paste it into the
   console, and press `Enter`. A panel appears in the top-right corner.

   > Chrome no longer supports the old address-bar `javascript:` bookmarklet — it
   > strips the scheme on paste, and the portal's Content-Security-Policy blocks
   > injected `<script src>` tags. Console paste works around both.

4. **Pick children and a date range**
   The panel groups your children by school, with everyone checked by default.
   Uncheck anyone you want to skip, set the dates, and click **Download**.

5. **Choose an output folder**
   Chrome will ask you to pick a folder. Media is written straight into a
   per-child subfolder inside it — no "download multiple files?" prompt, and no
   750-file dump into `~/Downloads`.

   If your browser doesn't support the folder picker (Firefox, Safari), the
   script falls back to normal downloads with `Child_date_id.jpg` filenames.

## Multiple Schools

**ProCare scopes its API to whichever school is selected in the portal.**
`/parent/kids/` returns a different set of children depending on the selection,
and the same child is issued a *different id* at each school. There is no way to
reach the other schools from a single run, and no endpoint that lists children
across all of them.

So if you have children at more than one school:

1. Select school #1 in the portal, run the script, pick an output folder.
2. Switch to school #2, run it again, choose **the same folder**.
3. Repeat for each school.

Files are filed by **child name**, not by child id — so a child who attends two
schools ends up in one folder rather than two, and the runs merge instead of
overwriting. The panel tells you how many schools your account has so you know
how many passes to make.

## Reaching Photos Older Than a Year

Several people have reported that ProCare returns nothing older than about a
year ([upstream issue #3][i3]) — while others can still browse 3+ year old
photos through the portal's own gallery by picking a specific month. That
pattern points at a cap on *wide* queries rather than actual deletion, so this
script asks for activity **one month at a time** and works backwards from the
most recent.

That means a 10-year range is ~120 requests per child and takes a while. If
your school does return everything in one shot, raise `CONFIG.dateWindowMonths`
near the top of the script to make runs much faster.

If your oldest photos genuinely are gone, they may still be recoverable from
ProCare's daily summary emails — see
[caseykho/procare-gmail-media-downloader](https://github.com/caseykho/procare-gmail-media-downloader).

[i3]: https://github.com/JWally/procare-media-downloader/issues/3

## Resuming an Interrupted Run

When saving to a folder, the script checks what's already on disk and skips it.
Re-running after a crash, a closed laptop, or a new batch of photos only
downloads what's actually new.

## What Else Gets Saved

Alongside the media, the script writes `procare-manifest_YYYY-MM-DD.json` into
the output folder — the full raw activity feed for the children and date range
you selected, in case you want captions, timestamps, or teacher notes later.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Couldn't find a Procare session on this page" | You're not signed in, or you're on the wrong domain. Sign in at `schools.procareconnect.com` and rerun from that tab. |
| "Procare rejected the session" | Your token expired. Reload the page, sign in again, repaste. |
| A child is missing | They're at a school you don't currently have selected. See [Multiple Schools](#multiple-schools). |
| Some files report `gone` (403/404) | Broken on ProCare's servers — they won't open on the website either, so they can't be recovered. Listed under `failures` in the manifest. |
| A handful of files fail | Usually videos ProCare is still transcoding. Rerun later — already-downloaded files are skipped. |
| Some files opened in new tabs instead of saving | Those URLs are served without CORS headers, so JavaScript can't read them. Save them from the tab manually. Listed under `failures` in the manifest. |
| Nothing older than ~1 year | See [Reaching Photos Older Than a Year](#reaching-photos-older-than-a-year). |
| Videos play as audio only | Fixed — the old script saved extension-less video URLs as `.mpeg`, which makes players pick an MPEG-1 decoder. Extensions now come from the server's `Content-Type`. |
| Downloads are slow or stall | Lower `CONFIG.concurrency` near the top of the script. |
| Not all your children show up | Run [`diagnose.js`](./diagnose.js) (see below). |

## Diagnostics

[`diagnose.js`](./diagnose.js) is a read-only probe for when something doesn't
line up — most often when the children you expect aren't all listed. Paste it
into the console the same way. It prints field names, counts, and endpoint
status codes with identifying values redacted, so the output is safe to share
in an issue.

If your account switches between schools, run it once per school and compare
the `kids.count` in each — that tells us whether the API is scoped to the
currently-selected school.

## Credits

Originally by [Justin Wolcott](https://github.com/JWally/procare-media-downloader)
([justin@wolcott.io](mailto:justin@wolcott.io)).

This fork adds multi-child / multi-school support, folder-based output, resume,
retries, month-windowed history, and a non-destructive overlay UI.

It also folds in fixes for problems reported upstream but not yet merged there:
- Chrome silently capping bulk downloads ([#2][i2], [PR #5][p5]) — solved by the
  File System Access API.
- ProCare rate-limiting mid-run ([PR #4][p4]) — retries with exponential backoff
  and `Retry-After` support.
- Videos saving as audio-only ([PR #4][p4]) — extension now derived from
  `Content-Type`.
- CORS-blocked media ([#2][i2]) — detected and opened for manual save instead of
  silently vanishing.
- Capturing photo timestamps ([#1][i1]) — in filenames, plus a full JSON manifest.
  To write them into EXIF, see
  [jsigman/procare-photo-timestamper](https://github.com/jsigman/procare-photo-timestamper).

[i1]: https://github.com/JWally/procare-media-downloader/issues/1
[i2]: https://github.com/JWally/procare-media-downloader/issues/2
[p4]: https://github.com/JWally/procare-media-downloader/pull/4
[p5]: https://github.com/JWally/procare-media-downloader/pull/5

## Note

This uses ProCare's private parent endpoints, which are undocumented and can
change without warning. It only reads data your account already has access to.
