/**
 * Procare Excavator
 * -----------------
 * Bulk-downloads photos and videos out of the Procare parent portal.
 *
 * Built for parents with more than one child. Media is filed per child, and
 * pulled from both of Procare's feeds - the activity timeline and the photo
 * gallery - because each carries media the other misses.
 *
 * MULTIPLE SCHOOLS
 *   Procare scopes its API to whichever school is selected in the portal:
 *   /parent/kids/ returns a different set of children per school, and the
 *   same child gets a different id at each one. There's no way to reach the
 *   others from here, so switch school in the portal and run this again.
 *   Point every run at the same folder - files are filed by child NAME, so a
 *   child attending two schools lands in one folder rather than two.
 *
 * HOW TO RUN
 *   1. Sign in at https://schools.procareconnect.com
 *   2. Open DevTools (F12) -> Console
 *   3. Paste this entire file, press Enter
 *   4. Use the panel that appears in the top-right corner
 *
 * Pasting into the Console (rather than the address bar) matters: Chrome strips
 * the `javascript:` scheme from pasted URLs, and the portal's Content-Security-
 * Policy blocks injected <script src> tags. Console evaluation is exempt from
 * both.
 *
 */

(async () => {
    "use strict";

    // Tear down a previous run if this file is pasted twice.
    if (window.__procareExcavator) {
        window.__procareExcavator.destroy();
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    const CONFIG = {
        /** Simultaneous media downloads. 4-6 is a good balance; higher gets throttled. */
        concurrency: 5,
        /** Attempts per file before giving up. */
        maxRetries: 3,
        /** Base backoff in ms; doubles each retry. */
        retryBackoffMs: 750,
        /** Hard stop on activity pagination, in case the API stops terminating. */
        maxPagesPerKid: 500,
        /**
         * Query the activity feed in windows this many months wide instead of
         * one wide range. Procare appears to cap wide queries at ~1 year, so
         * asking month by month reaches older media. Raise it to make a run
         * faster if your school does return everything in one shot.
         */
        dateWindowMonths: 1,
        /** Delay between anchor-tag downloads when the folder picker isn't available. */
        anchorDownloadDelayMs: 250,

        /**
         * Media URL fields on an activity payload, best quality first.
         *
         * We do NOT filter by activity_type. A real account shows photos
         * arriving on learning_activity and note_activity as well as
         * photo_activity, so anything carrying a media URL is fair game.
         */
        urlKeys: [
            "original_url", "large_url", "main_url", "url",
            "photo_url", "image_url", "file_url", "video_file_url",
        ],
        /** Field names whose URLs are page furniture, not your kid's photos. */
        skipUrlKeys: ["avatar", "icon", "logo", "staff", "teacher", "signature", "badge", "profile"],
        /** URL path fragments that mark the same. */
        skipUrlPaths: ["/profile_pics/", "profilepic", "/avatars/", "/avatar/", "/logos/"],
    };

    // ---------------------------------------------------------------------
    // Environment / auth
    // ---------------------------------------------------------------------

    /**
     * Resolves the API hostname from the portal hostname.
     * schools.procareconnect.com -> api-school.procareconnect.com
     * @returns {string}
     */
    const getApiHost = () => {
        const host = location.host;
        if (host.includes("api-school")) return host;
        if (host.includes("schools")) return host.replace("schools", "api-school");
        // Unknown host shape - fall back to the public portal's API.
        return "api-school.procareconnect.com";
    };

    /**
     * Reads the bearer token out of the portal's Redux-persist blob.
     * Read fresh on every request so a mid-run token refresh is picked up.
     * @returns {string}
     * @throws {Error} if the user isn't signed in on this domain.
     */
    const getAuthToken = () => {
        let token;
        try {
            const persisted = JSON.parse(localStorage["persist:kinderlime"]);
            token = JSON.parse(persisted.currentUser).data.auth_token;
        } catch (err) {
            throw new Error(
                "Couldn't find a Procare session on this page. Sign in at " +
                "https://schools.procareconnect.com and run this again from that tab."
            );
        }
        if (!token) throw new Error("Procare session found but it has no auth token. Sign in again.");
        return token;
    };

    const API_HOST = getApiHost();
    const API_ROOT = `https://${API_HOST}/api/web/parent`;

    // ---------------------------------------------------------------------
    // Small utilities
    // ---------------------------------------------------------------------

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Strips characters that are illegal or awkward in file and folder names.
     * @param {string} value
     * @param {string} fallback - used when the input sanitizes down to nothing.
     * @returns {string}
     */
    const sanitize = (value, fallback = "unknown") => {
        const cleaned = String(value ?? "")
            .replace(/[\\/:*?"<>|]/g, "-")   // illegal on Windows and/or POSIX
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^\.+|\.+$/g, "");      // no leading/trailing dots
        return cleaned || fallback;
    };

    /**
     * Returns the first non-empty value found at any of the given object paths.
     * Lets us tolerate Procare renaming or nesting fields without breaking.
     * @param {Object} obj
     * @param {Array<string>} paths - dot-delimited paths, tried in order.
     * @returns {*} the first truthy value, or undefined.
     */
    const pick = (obj, paths) => {
        for (const path of paths) {
            const value = path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return undefined;
    };

    /**
     * Reads a Retry-After header into milliseconds. Accepts both the
     * delta-seconds and HTTP-date forms.
     * @param {Response} response
     * @returns {number} ms to wait, clamped to a sane ceiling; 0 if absent.
     */
    const retryAfterMs = (response) => {
        const header = response.headers.get("retry-after");
        if (!header) return 0;

        const seconds = Number(header);
        const ms = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(header) - Date.now();

        if (!Number.isFinite(ms) || ms <= 0) return 0;
        return Math.min(ms, 60_000);
    };

    /**
     * Pulls a file extension off a URL, ignoring query strings and signatures.
     * @param {string} url
     * @param {string} fallback
     * @returns {string}
     */
    const getFileExtension = (url, fallback = "jpg") => {
        try {
            const last = new URL(url, location.origin).pathname.split("/").pop() || "";
            const idx = last.lastIndexOf(".");
            if (idx === -1) return fallback;
            const ext = last.slice(idx + 1).toLowerCase();
            return /^[a-z0-9]{2,5}$/.test(ext) ? ext : fallback;
        } catch {
            return fallback;
        }
    };

    // ---------------------------------------------------------------------
    // API layer
    // ---------------------------------------------------------------------

    /**
     * Authenticated GET against the Procare parent API, with retry on
     * transient failures.
     *
     * Note: only headers a browser actually lets us set are sent here. The
     * previous version set Host, Connection, User-Agent, Origin, Referer and
     * the Sec-Fetch-* family, all of which are forbidden header names that
     * fetch() silently discards.
     *
     * @param {string} url
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<Object>} parsed JSON body.
     */
    const apiGet = async (url, options = {}) => {
        let lastError;
        let extraWaitMs = 0;

        for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
            if (attempt > 0) await sleep(CONFIG.retryBackoffMs * 2 ** (attempt - 1) + extraWaitMs);
            extraWaitMs = 0;

            // Outside the try: a missing session is not a transient failure,
            // so it should surface immediately rather than retry-with-backoff.
            const token = getAuthToken();

            try {
                const response = await fetch(url, {
                    signal: options.signal,
                    headers: {
                        Accept: "application/json, text/plain, */*",
                        Authorization: `Bearer ${token}`,
                    },
                });

                if (response.status === 401 || response.status === 403) {
                    // Not transient - more retries won't help.
                    throw new Error(`Procare rejected the session (HTTP ${response.status}). Sign in again.`);
                }
                if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                    // A client error is a verdict, not a hiccup. The gallery
                    // endpoint 400s on backends that don't support it, and
                    // retrying that three times with backoff burned ~5s per
                    // month window for nothing.
                    const err = new Error(`HTTP ${response.status} for ${url}`);
                    err.permanent = true;
                    throw err;
                }
                if (response.status === 429) {
                    // Procare rate-limits under load. Honour Retry-After when
                    // it sends one, rather than hammering through the backoff.
                    extraWaitMs = retryAfterMs(response);
                    throw new Error(`Rate limited (HTTP 429) for ${url}`);
                }
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
                }

                return await response.json();
            } catch (err) {
                if (err.name === "AbortError") throw err;
                if (err.permanent) throw err;
                if (/rejected the session/.test(err.message)) throw err;
                lastError = err;
            }
        }

        throw lastError;
    };

    /**
     * The school currently selected in the portal, from the persisted session.
     *
     * Kid records carry no school reference at all - no `school_id`, no nested
     * school object - so this is the only place the name is available. It also
     * matters because the API is scoped to this selection: `/parent/kids/`
     * returns a different set of children per school, with different ids for
     * the same child.
     *
     * @returns {{id: ?string, name: string, available: Array<string>}}
     */
    const getCurrentSchool = () => {
        try {
            const persisted = JSON.parse(localStorage["persist:kinderlime"]);
            const user = JSON.parse(persisted.currentUser).data;
            return {
                id: user.current_school?.id ?? null,
                name: sanitize(user.current_school?.name, "school"),
                available: (user.carer_schools || [])
                    .map((s) => s?.name)
                    .filter(Boolean),
            };
        } catch {
            return { id: null, name: "school", available: [] };
        }
    };

    /**
     * Lists the children visible under the currently selected school.
     * @param {AbortSignal} [signal]
     * @returns {Promise<{raw: Object, kids: Array<Object>}>}
     */
    const listKids = async (signal) => {
        const raw = await apiGet(`${API_ROOT}/kids/`, { signal });
        const kids = raw.kids || raw.data || (Array.isArray(raw) ? raw : []);

        // Shape of the kid object isn't publicly documented and does drift.
        // Log one so it's easy to see what we're working with.
        if (kids.length) console.debug("[procare] sample kid payload:", kids[0]);

        return {
            raw,
            kids: kids.map((kid) => ({
                id: pick(kid, ["id", "kid_id", "uuid"]),
                name: sanitize(
                    pick(kid, ["name", "full_name", "display_name", "first_name"]) ??
                        [kid.first_name, kid.last_name].filter(Boolean).join(" "),
                    `kid-${pick(kid, ["id"]) ?? "unknown"}`
                ),
                raw: kid,
            })).filter((kid) => kid.id != null),
        };
    };

    /**
     * Splits a date range into consecutive windows of at most `months` months.
     *
     * Several users report that a single wide query returns nothing older than
     * about a year, while the portal's own gallery happily shows 3+ year old
     * photos when you pick a specific month. That points at a server-side cap
     * on a wide range rather than actual deletion, so we ask month by month.
     * See https://github.com/JWally/procare-media-downloader/issues/3
     *
     * @param {string} dateFrom - YYYY-MM-DD, inclusive.
     * @param {string} dateTo - YYYY-MM-DD, inclusive.
     * @param {number} months - window size.
     * @returns {Array<{from: string, to: string}>} newest window first.
     */
    const splitDateRange = (dateFrom, dateTo, months) => {
        const iso = (d) => d.toISOString().slice(0, 10);
        const start = new Date(`${dateFrom}T00:00:00Z`);
        const end = new Date(`${dateTo}T00:00:00Z`);
        if (!(start <= end)) return [];

        const windows = [];
        let cursor = new Date(start);
        while (cursor <= end) {
            const next = new Date(cursor);
            next.setUTCMonth(next.getUTCMonth() + months);
            const windowEnd = new Date(Math.min(next.getTime() - 86_400_000, end.getTime()));
            windows.push({ from: iso(cursor), to: iso(windowEnd) });
            cursor = next;
        }
        // Newest first: recent photos are what people usually want, and it
        // means an interrupted run still got the useful half.
        return windows.reverse();
    };

    /**
     * Walks the paginated daily-activities feed for one child, one date window
     * at a time.
     *
     * Rewritten as a loop rather than recursion, with two termination guards
     * the original lacked: a page cap, and duplicate-id detection for the case
     * where the API ignores `page` and keeps handing back the same results.
     *
     * @param {Object} kid - entry from listKids().
     * @param {string} dateFrom - YYYY-MM-DD
     * @param {string} dateTo - YYYY-MM-DD
     * @param {{signal?: AbortSignal, onProgress?: Function}} [options]
     * @returns {Promise<Array<Object>>} activities, each tagged with its kid.
     */
    const fetchActivityWindow = async (kid, window, options = {}) => {
        const activities = [];
        const seenIds = new Set();

        for (let page = 1; page <= CONFIG.maxPagesPerKid; page++) {
            const params = new URLSearchParams({
                kid_id: kid.id,
                "filters[daily_activity][date_from]": window.from,
                "filters[daily_activity][date_to]": window.to,
                page: String(page),
            });

            const body = await apiGet(`${API_ROOT}/daily_activities/?${params}`, { signal: options.signal });
            const batch = body.daily_activities || [];
            if (batch.length === 0) break;

            const fresh = batch.filter((activity) => !seenIds.has(activity.id));
            if (fresh.length === 0) break; // API is repeating itself - stop.

            for (const activity of fresh) {
                seenIds.add(activity.id);
                activity.__kid = { id: kid.id, name: kid.name };
                activities.push(activity);
            }
        }

        return activities;
    };

    /**
     * Reads one date window from the gallery feed for one child.
     *
     * This is a second, separate source from the activity feed. Some photos
     * land in the gallery without ever producing an activity record, so a
     * downloader that only reads activities quietly misses them. Note the
     * different parameter shape: `filters[photo][datetime_from]`, with a time
     * component, versus the activity feed's `date_from`.
     *
     * Only photos - the same endpoint returns HTTP 400 for a `video` filter,
     * so videos come from the activity feed alone.
     *
     * @param {Object} kid
     * @param {{from: string, to: string}} window
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<Array<Object>>} gallery photo records, tagged with kid.
     */
    const galleryUnsupported = new Set();

    const fetchGalleryWindow = async (kid, window, options = {}) => {
        // Once a backend has told us it doesn't do galleries, believe it.
        // Otherwise we'd re-ask - and re-fail - on every month window.
        if (galleryUnsupported.has(kid.id)) return [];

        const photos = [];
        const seenIds = new Set();

        for (let page = 1; page <= CONFIG.maxPagesPerKid; page++) {
            const params = new URLSearchParams({
                kid_id: kid.id,
                page: String(page),
                "filters[photo][datetime_from]": `${window.from} 00:00`,
                "filters[photo][datetime_to]": `${window.to} 23:59`,
            });

            let body;
            try {
                body = await apiGet(`${API_ROOT}/photos/?${params}`, { signal: options.signal });
            } catch (err) {
                if (err.name === "AbortError") throw err;
                // Older backends 400 here. That means "no gallery", not a
                // failure worth aborting the run over.
                if (err.permanent) {
                    galleryUnsupported.add(kid.id);
                    console.debug(`[procare] no gallery feed for ${kid.name}; activity feed only.`);
                }
                break;
            }

            const batch = body.photos || [];
            if (batch.length === 0) break;

            const fresh = batch.filter((photo) => !seenIds.has(photo.id));
            if (fresh.length === 0) break;

            for (const photo of fresh) {
                seenIds.add(photo.id);
                photo.__kid = { id: kid.id, name: kid.name };
                photos.push(photo);
            }

            // The gallery reports its own total, so we can stop exactly.
            if (typeof body.total === "number" && photos.length >= body.total) break;
        }

        return photos;
    };

    // ---------------------------------------------------------------------
    // Media extraction
    // ---------------------------------------------------------------------

    /**
     * True if a URL is page furniture (a teacher's avatar, a school logo)
     * rather than a photo of a child.
     * @param {string} key - the field name the URL came from.
     * @param {string} url
     * @returns {boolean}
     */
    const isDecoration = (key, url) => {
        const k = key.toLowerCase();
        if (CONFIG.skipUrlKeys.some((frag) => k.includes(frag))) return true;
        const path = String(url).toLowerCase();
        return CONFIG.skipUrlPaths.some((frag) => path.includes(frag));
    };

    /**
     * Picks the single best media URL off a payload.
     *
     * Procare often offers the same photo at several resolutions under
     * different keys, so we take the highest-quality one rather than
     * downloading all of them.
     *
     * @param {Object} payload
     * @returns {?{url: string, key: string}}
     */
    const bestMediaUrl = (payload) => {
        if (!payload || typeof payload !== "object") return null;
        for (const key of CONFIG.urlKeys) {
            const url = payload[key];
            if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
            if (isDecoration(key, url)) continue;
            return { url, key };
        }
        return null;
    };

    /**
     * Turns an activity or gallery record into a downloadable item, or null
     * if it carries no usable asset (e.g. a video still transcoding).
     *
     * @param {Object} record - an activity, or a gallery photo.
     * @param {"activity"|"gallery"} source
     * @returns {?Object}
     */
    const toMediaItem = (record, source) => {
        // Activities nest the real object under Procare's misspelled
        // "activiable" key; gallery records are already the media object.
        const payload = source === "gallery"
            ? record
            : (record.activiable || record.activityable || record);

        const isVideo = record.activity_type === "video_activity" || !!payload.video_file_url;
        const found = isVideo && payload.video_file_url
            ? { url: payload.video_file_url, key: "video_file_url" }
            : bestMediaUrl(payload);

        if (!found) return null;

        const kid = record.__kid || { name: "unknown" };
        const takenAt =
            pick(payload, ["created_at", "captured_at", "taken_at"]) ||
            pick(record, ["activity_time", "created_at"]) ||
            "";
        const stamp = sanitize(String(takenAt).replace(/\..*$/, "").replace(/:/g, "-"), "undated");
        const id = pick(payload, ["id"]) ?? record.id;
        const ext = getFileExtension(found.url, isVideo ? "mp4" : "jpg");

        return {
            url: found.url,
            kid: kid.name,
            source,
            // Child name is in the filename as well as the folder so the flat
            // fallback downloads stay unambiguous.
            filename: `${sanitize(kid.name)}_${stamp}_${id}.${ext}`,
        };
    };

    // ---------------------------------------------------------------------
    // Output: real folders when the browser allows it, downloads otherwise
    // ---------------------------------------------------------------------

    /**
     * Writes files into a user-chosen folder via the File System Access API.
     * This avoids Chrome's "download multiple files?" prompt entirely, gives
     * real per-child subfolders, and lets us skip files already present so an
     * interrupted run can be resumed.
     *
     * Folders are keyed on the child's NAME, not their id. Procare issues a
     * separate kid record (and a separate UUID) per school, so a child who
     * attends two schools would otherwise land in two folders. Keying on the
     * name merges them, which is what you actually want.
     */
    class DirectoryWriter {
        /** @param {FileSystemDirectoryHandle} root */
        constructor(root) {
            this.root = root;
            this.dirCache = new Map();
            this.label = "folder";
        }

        /** @returns {Promise<FileSystemDirectoryHandle>} */
        async #dirFor(kid) {
            if (this.dirCache.has(kid)) return this.dirCache.get(kid);
            const kidDir = await this.root.getDirectoryHandle(kid, { create: true });
            this.dirCache.set(kid, kidDir);
            return kidDir;
        }

        /**
         * @param {Object} item - from toMediaItem()
         * @returns {Promise<boolean>} true if the file is already on disk.
         */
        async exists(item) {
            try {
                const dir = await this.#dirFor(item.kid);
                const handle = await dir.getFileHandle(item.filename);
                const file = await handle.getFile();
                return file.size > 0;
            } catch {
                return false;
            }
        }

        /**
         * @param {Object} item
         * @param {Blob} blob
         */
        async write(item, blob) {
            const dir = await this.#dirFor(item.kid);
            const handle = await dir.getFileHandle(item.filename, { create: true });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
        }

        /** @param {string} name @param {Blob} blob */
        async writeToRoot(name, blob) {
            const handle = await this.root.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
        }
    }

    /**
     * Fallback for browsers without the File System Access API: one <a download>
     * per file, into the default Downloads folder. No subfolders are possible,
     * so school and child are folded into the filename instead.
     */
    class AnchorWriter {
        constructor() {
            this.label = "Downloads folder (flat filenames)";
        }

        /** Always false - we can't inspect the Downloads folder. */
        async exists() {
            return false;
        }

        /** @param {Object} item @param {Blob} blob */
        async write(item, blob) {
            // No subfolders available, so the child's name stays in the name.
            await this.writeToRoot(item.filename, blob);
            await sleep(CONFIG.anchorDownloadDelayMs);
        }

        /** @param {string} name @param {Blob} blob */
        async writeToRoot(name, blob) {
            const href = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = href;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            // Revoking immediately can cancel the download mid-flight in Chrome.
            setTimeout(() => URL.revokeObjectURL(href), 60_000);
        }
    }

    /**
     * Prompts for an output folder, falling back to plain downloads.
     * @returns {Promise<DirectoryWriter|AnchorWriter>}
     */
    const createWriter = async () => {
        if (typeof window.showDirectoryPicker !== "function") return new AnchorWriter();
        try {
            const root = await window.showDirectoryPicker({ id: "procare-media", mode: "readwrite" });
            return new DirectoryWriter(root);
        } catch (err) {
            if (err.name === "AbortError") return new AnchorWriter();
            console.warn("[procare] folder picker unavailable, falling back to downloads:", err);
            return new AnchorWriter();
        }
    };

    // ---------------------------------------------------------------------
    // Download pipeline
    // ---------------------------------------------------------------------

    /**
     * Maps a response Content-Type onto a file extension.
     *
     * This matters most for video. Procare's video URLs often carry no
     * extension at all, and the original script turned that into a `.mpeg`
     * filename -- which makes players reach for an MPEG-1 decoder, find no
     * video stream it understands, and play audio only. That is the
     * "videos download as audio" bug reported upstream; the bytes were
     * always fine, the extension was not.
     * See https://github.com/JWally/procare-media-downloader/pull/4
     *
     * @param {string} contentType
     * @returns {?string} extension without the dot, or null if unrecognised.
     */
    const extensionFromContentType = (contentType) => {
        const type = String(contentType || "").split(";")[0].trim().toLowerCase();
        const map = {
            "image/jpeg": "jpg",
            "image/jpg": "jpg",
            "image/png": "png",
            "image/gif": "gif",
            "image/webp": "webp",
            "image/heic": "heic",
            "video/mp4": "mp4",
            "video/quicktime": "mov",
            "video/webm": "webm",
            "video/x-m4v": "m4v",
            "video/3gpp": "3gp",
        };
        return map[type] || null;
    };

    /**
     * Swaps the extension on a filename.
     * @param {string} filename
     * @param {string} extension
     * @returns {string}
     */
    const withExtension = (filename, extension) =>
        `${filename.replace(/\.[^.]*$/, "")}.${extension}`;

    /**
     * Last-resort download for assets the browser won't let us read.
     *
     * Some Procare media is served without an Access-Control-Allow-Origin
     * header, so fetch() can never see the bytes no matter how many times we
     * retry. Navigating to the URL in a new tab sidesteps CORS entirely --
     * the browser saves or displays it without JavaScript touching the body.
     * The tradeoff is we lose control of the filename and the folder.
     * See https://github.com/JWally/procare-media-downloader/issues/2
     *
     * @param {Object} item
     */
    const openForManualSave = (item) => {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.download = item.filename; // honoured same-origin, ignored otherwise
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    /**
     * Fetches one media item and hands it to the writer, with retries.
     * @param {Object} item
     * @param {DirectoryWriter|AnchorWriter} writer
     * @param {AbortSignal} signal
     * @returns {Promise<"saved"|"skipped"|"failed"|"cors"|"gone">}
     */
    const downloadItem = async (item, writer, signal) => {
        if (await writer.exists(item)) return "skipped";

        let lastError;
        let corsBlocked = false;
        let gone = false;

        for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
            if (attempt > 0) await sleep(CONFIG.retryBackoffMs * 2 ** (attempt - 1));
            try {
                const response = await fetch(item.url, { signal });

                if (response.status === 429) {
                    await sleep(retryAfterMs(response) || CONFIG.retryBackoffMs * 4);
                    throw new Error("rate limited (HTTP 429)");
                }
                if (response.status === 403 || response.status === 404) {
                    // The media host is answering, and its answer is no. These
                    // are signed URLs: a 403 means the signature is rejected,
                    // which no amount of retrying changes. In practice these
                    // are files broken on Procare's side - they won't open on
                    // the website either.
                    gone = true;
                    throw new Error(`HTTP ${response.status}`);
                }
                if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

                const blob = await response.blob();
                if (blob.size === 0) throw new Error("empty response body");

                // Trust the server's Content-Type over the URL's extension.
                const serverExt = extensionFromContentType(response.headers.get("content-type"));
                if (serverExt) item.filename = withExtension(item.filename, serverExt);

                await writer.write(item, blob);
                return "saved";
            } catch (err) {
                if (err.name === "AbortError") throw err;
                // A CORS rejection surfaces as an opaque TypeError with no
                // status. Retrying is pointless - the header won't appear.
                if (err instanceof TypeError) corsBlocked = true;
                lastError = err;
                if (corsBlocked || gone) break;
            }
        }

        if (gone) {
            item.error = String(lastError);
            return "gone";
        }

        if (corsBlocked) {
            console.warn(`[procare] ${item.filename} is CORS-blocked; opening it for manual save.`);
            openForManualSave(item);
            return "cors";
        }

        console.warn(`[procare] gave up on ${item.filename}:`, lastError);
        item.error = String(lastError);
        return "failed";
    };

    /**
     * Runs tasks with a fixed-size worker pool.
     *
     * The old implementation used Promise.race over a shrinking array, which
     * both leaked settled promises and let the pool drift above its limit.
     *
     * @param {Array<*>} items
     * @param {number} limit
     * @param {function(*, number): Promise<*>} worker
     * @returns {Promise<Array<*>>} results, in input order.
     */
    const runPool = async (items, limit, worker) => {
        const results = new Array(items.length);
        let cursor = 0;

        const runner = async () => {
            while (cursor < items.length) {
                const index = cursor++;
                results[index] = await worker(items[index], index);
            }
        };

        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
        return results;
    };

    // ---------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------

    const PANEL_ID = "procare-excavator-panel";
    const css = `
        #${PANEL_ID} {
            position: fixed; top: 16px; right: 16px; z-index: 2147483647;
            width: 380px; max-height: calc(100vh - 32px);
            display: flex; flex-direction: column;
            background: #fff; color: #222; border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,.28);
            font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #${PANEL_ID} * { box-sizing: border-box; }
        #${PANEL_ID} header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 14px; background: #1f2937; color: #fff;
            border-radius: 10px 10px 0 0; font-weight: 600;
        }
        #${PANEL_ID} header button {
            background: none; border: none; color: #fff; font-size: 18px;
            cursor: pointer; line-height: 1; padding: 0 4px;
        }
        #${PANEL_ID} .pe-body { padding: 12px 14px; overflow-y: auto; }
        #${PANEL_ID} .pe-school { margin-bottom: 12px; }
        #${PANEL_ID} .pe-school > strong {
            display: block; font-size: 11px; text-transform: uppercase;
            letter-spacing: .06em; color: #6b7280; margin-bottom: 4px;
        }
        #${PANEL_ID} label.pe-kid {
            display: flex; align-items: center; gap: 8px;
            padding: 3px 0; cursor: pointer;
        }
        #${PANEL_ID} .pe-dates { display: flex; gap: 8px; margin: 4px 0 12px; }
        #${PANEL_ID} .pe-dates label { flex: 1; font-size: 11px; color: #6b7280; }
        #${PANEL_ID} .pe-dates input {
            width: 100%; padding: 5px 6px; border: 1px solid #d1d5db;
            border-radius: 5px; font-size: 13px;
        }
        #${PANEL_ID} .pe-actions { display: flex; gap: 8px; }
        #${PANEL_ID} .pe-actions button {
            flex: 1; padding: 9px; border: none; border-radius: 6px;
            font-size: 14px; font-weight: 600; cursor: pointer;
        }
        #${PANEL_ID} .pe-go { background: #2563eb; color: #fff; }
        #${PANEL_ID} .pe-go:disabled { background: #9ca3af; cursor: not-allowed; }
        #${PANEL_ID} .pe-stop { background: #e5e7eb; color: #374151; }
        #${PANEL_ID} .pe-status {
            margin-top: 12px; padding-top: 10px; border-top: 1px solid #e5e7eb;
            font-size: 12px; color: #374151; white-space: pre-wrap;
        }
        #${PANEL_ID} progress { width: 100%; height: 8px; margin-top: 6px; }
        #${PANEL_ID} .pe-note { font-size: 11px; color: #6b7280; margin-top: 8px; }
        #${PANEL_ID} a { color: #2563eb; }
    `;

    const styleEl = document.createElement("style");
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
        <header>
            <span>Procare Excavator</span>
            <button type="button" class="pe-close" title="Close">&times;</button>
        </header>
        <div class="pe-body">
            <div class="pe-kids">Loading children&hellip;</div>
            <div class="pe-dates">
                <label>From<input type="date" class="pe-from"></label>
                <label>To<input type="date" class="pe-to"></label>
            </div>
            <div class="pe-actions">
                <button type="button" class="pe-go" disabled>Download</button>
                <button type="button" class="pe-stop" hidden>Stop</button>
            </div>
            <div class="pe-status">Idle.</div>
            <progress class="pe-progress" value="0" max="1" hidden></progress>
            <div class="pe-note"></div>
        </div>
    `;
    document.body.appendChild(panel);

    const $ = (selector) => panel.querySelector(selector);
    const kidsEl = $(".pe-kids");
    const fromEl = $(".pe-from");
    const toEl = $(".pe-to");
    const goEl = $(".pe-go");
    const stopEl = $(".pe-stop");
    const statusEl = $(".pe-status");
    const progressEl = $(".pe-progress");
    const noteEl = $(".pe-note");

    const setStatus = (text) => { statusEl.textContent = text; };
    const setNote = (html) => { noteEl.innerHTML = html; };

    // Default to three years back rather than "the beginning of time": the
    // feed is queried one month at a time, so an over-wide range is hundreds
    // of pointless requests and a good way to get rate limited. Widen it by
    // hand if a child has been enrolled longer.
    const defaultFrom = new Date();
    defaultFrom.setUTCFullYear(defaultFrom.getUTCFullYear() - 3);
    fromEl.value = defaultFrom.toISOString().slice(0, 10);
    toEl.value = new Date().toISOString().slice(0, 10);

    let controller = null;

    const destroy = () => {
        controller?.abort();
        panel.remove();
        styleEl.remove();
        delete window.__procareExcavator;
    };

    $(".pe-close").addEventListener("click", destroy);
    window.__procareExcavator = { destroy, CONFIG };

    // --- populate the kid list -------------------------------------------

    let kids = [];
    const school = getCurrentSchool();
    try {
        const result = await listKids();
        kids = result.kids;
    } catch (err) {
        kidsEl.textContent = err.message;
        setStatus("Couldn't load children.");
        return;
    }

    if (kids.length === 0) {
        kidsEl.textContent = "No children found on this account.";
        return;
    }

    // Only ever one school's worth of children: the API is scoped to whichever
    // school is selected in the portal.
    const group = document.createElement("div");
    group.className = "pe-school";
    group.innerHTML = `<strong>${school.name}</strong>`;
    for (const kid of kids) {
        const label = document.createElement("label");
        label.className = "pe-kid";
        label.innerHTML = `<input type="checkbox" checked value="${kid.id}"> ${kid.name}`;
        group.appendChild(label);
    }
    kidsEl.innerHTML = "";
    kidsEl.appendChild(group);
    goEl.disabled = false;

    if (school.available.length > 1) {
        // The downloader can't change the selection itself, but it can make
        // sure you know there's more to collect.
        setNote(
            `This account has <b>${school.available.length} schools</b>. Procare only exposes ` +
            `the selected one, so switch school in the portal and run this again ` +
            `for the rest. Point every run at the same folder - files are filed ` +
            `by child name, so they merge rather than overwrite.`
        );
    }

    setStatus(`${kids.length} child(ren) at ${school.name}.`);

    // --- the run ----------------------------------------------------------

    const run = async () => {
        const selected = kids.filter((kid) =>
            panel.querySelector(`.pe-kid input[value="${kid.id}"]`)?.checked
        );
        if (selected.length === 0) {
            setStatus("Pick at least one child.");
            return;
        }

        const dateFrom = fromEl.value || "2000-01-01";
        const dateTo = toEl.value || new Date().toISOString().slice(0, 10);

        controller = new AbortController();
        const { signal } = controller;
        goEl.disabled = true;
        stopEl.hidden = false;
        progressEl.hidden = false;
        progressEl.value = 0;

        try {
            // Destination first: the scan is interleaved with downloading, so
            // we need somewhere to put files before we start.
            setStatus("Choose where to save…");
            const writer = await createWriter();

            const windows = splitDateRange(dateFrom, dateTo, CONFIG.dateWindowMonths);
            const manifest = {
                exported_at: new Date().toISOString(),
                portal: location.origin,
                school: { id: school.id, name: school.name },
                date_from: dateFrom,
                date_to: dateTo,
                children: selected.map((k) => ({ id: k.id, name: k.name })),
                months: windows.length,
                media: [],
                failures: [],
            };
            const manifestName = `procare-manifest_${new Date().toISOString().slice(0, 10)}.json`;

            const tally = { saved: 0, skipped: 0, failed: 0, cors: 0, gone: 0 };
            const seenUrls = new Set();
            let found = 0;

            progressEl.max = windows.length;

            // Scan one month, download that month, then move on.
            //
            // Procare's media URLs are short-lived signed links. Collecting
            // every URL up front and downloading afterwards means the earliest
            // ones have expired (HTTP 403) by the time we reach them - which
            // gets worse the longer the date range. Interleaving keeps every
            // URL seconds-to-minutes old when it's used.
            for (const [index, window] of windows.entries()) {
                if (signal.aborted) break;
                const month = window.from.slice(0, 7);
                progressEl.value = index;

                // --- scan this window, across both feeds, for every child ---
                const batches = await runPool(selected, 2, async (kid) => {
                    setStatus(`Scanning ${month} (${index + 1}/${windows.length})…\n${kid.name}`);
                    const [activities, gallery] = await Promise.all([
                        fetchActivityWindow(kid, window, { signal }),
                        fetchGalleryWindow(kid, window, { signal }),
                    ]);
                    return [
                        ...activities.map((a) => toMediaItem(a, "activity")),
                        ...gallery.map((p) => toMediaItem(p, "gallery")),
                    ].filter(Boolean);
                });

                // The two feeds overlap heavily - the same photo usually
                // appears in both - so dedupe on URL before downloading.
                const items = [];
                for (const item of batches.flat()) {
                    if (seenUrls.has(item.url)) continue;
                    seenUrls.add(item.url);
                    items.push(item);
                }
                if (items.length === 0) continue;

                found += items.length;

                // --- download it immediately ---
                let done = 0;
                await runPool(items, CONFIG.concurrency, async (item) => {
                    const outcome = await downloadItem(item, writer, signal);
                    tally[outcome]++;
                    done++;
                    setStatus(
                        `${month} (${index + 1}/${windows.length}) — ${done}/${items.length}\n` +
                        `saved ${tally.saved} · had ${tally.skipped} · ` +
                        `gone ${tally.gone} · failed ${tally.failed} · tabs ${tally.cors}`
                    );
                    return outcome;
                });

                manifest.media.push(...items.map(({ kid, filename, url, source }) =>
                    ({ kid, filename, url, source, month })));
                manifest.failures.push(...items
                    .filter((item) => item.error)
                    .map(({ kid, filename, url, error }) => ({ kid, filename, url, error })));
            }

            progressEl.value = windows.length;
            await writer.writeToRoot(manifestName, new Blob(
                [JSON.stringify(manifest, null, 2)], { type: "application/json" }
            ));

            if (found === 0) {
                setStatus(`No photos or videos found in ${dateFrom} – ${dateTo}.`);
                return;
            }

            setStatus(
                `Done. ${tally.saved} saved, ${tally.skipped} already present, ${tally.failed} failed.` +
                (tally.gone
                    ? `\n${tally.gone} file(s) returned 403/404 - broken on Procare's side, not recoverable.`
                    : "") +
                (tally.cors
                    ? `\n${tally.cors} file(s) blocked by CORS were opened in new tabs - save those manually.`
                    : "")
            );
        } catch (err) {
            if (err.name === "AbortError") {
                setStatus("Stopped.");
            } else {
                console.error("[procare]", err);
                setStatus(`Error: ${err.message}`);
            }
        } finally {
            controller = null;
            goEl.disabled = false;
            stopEl.hidden = true;
        }
    };

    goEl.addEventListener("click", run);
    stopEl.addEventListener("click", () => controller?.abort());
})();
