/**
 * Procare Excavator - diagnostic probe
 * ------------------------------------
 * Read-only. Figures out how your account exposes multiple schools, so the
 * downloader can be pointed at all of them instead of just the one that
 * happens to be selected.
 *
 * It prints *field names* and counts, and redacts the values that identify
 * you or your kids, so the output is safe to paste into a chat or an issue.
 *
 * HOW TO RUN
 *   1. Sign in at https://schools.procareconnect.com
 *   2. Switch to school #1
 *   3. Open DevTools (F12) -> Console, paste this whole file, press Enter
 *   4. Copy the output
 *   5. Switch to school #2, repeat. Then school #3.
 *
 * The thing we're looking for: does `kids.count` change when you switch
 * schools? If it does, the API is scoped to the selected school and the
 * downloader needs to iterate schools explicitly.
 */

(async () => {
    "use strict";

    const SENSITIVE = /name|email|phone|address|token|url|photo|avatar|signature|guardian|parent|contact/i;

    /**
     * Replaces identifying values with type/length placeholders, keeping the
     * structure and field names intact.
     * @param {*} value
     * @param {number} [depth]
     * @returns {*}
     */
    const redact = (value, depth = 0) => {
        if (depth > 4) return "«deep»";
        if (Array.isArray(value)) return value.slice(0, 2).map((v) => redact(v, depth + 1));
        if (value && typeof value === "object") {
            const out = {};
            for (const [key, val] of Object.entries(value)) {
                out[key] = SENSITIVE.test(key) && val
                    ? `«${typeof val}:${String(val).length}»`
                    : redact(val, depth + 1);
            }
            return out;
        }
        if (typeof value === "string" && value.length > 60) return `«string:${value.length}»`;
        return value;
    };

    const report = {};
    const apiHost = location.host.includes("schools")
        ? location.host.replace("schools", "api-school")
        : location.host;

    // --- 1. What's in the persisted session? -----------------------------
    let token;
    try {
        const persisted = JSON.parse(localStorage["persist:kinderlime"]);
        report.persist_keys = Object.keys(persisted);

        const user = JSON.parse(persisted.currentUser).data;
        token = user.auth_token;
        report.currentUser_fields = Object.keys(user);
        report.currentUser_redacted = redact(user);

        // THE decisive question for a multi-school account.
        //
        // Procare's login response carries a `sites` list, and multi-tenant
        // schools each live on their own `api-school.<school>.procareconnect.com`
        // host. If your three schools are three entries here, then a single
        // API host can never see all of them -- which is exactly what the
        // current downloader assumes.
        const sites = user.sites;
        if (Array.isArray(sites)) {
            const hosts = sites.map((s) => {
                try {
                    return new URL(s.base_url).hostname;
                } catch {
                    return null;
                }
            });
            report.sites = {
                count: sites.length,
                field_names: Object.keys(sites[0] || {}),
                distinct_hosts: new Set(hosts.filter(Boolean)).size,
                // Keep the shape, drop the school identity: we only need to
                // know whether the hosts differ, not what they're called.
                host_pattern: hosts.map((h) =>
                    h ? h.replace(/^api-school\.([^.]+)\./, "api-school.«school».") : null
                ),
                is_default_flags: sites.map((s) => !!s?.is_default),
            };
        } else {
            report.sites = "absent from currentUser";
        }

        // The school switcher has to store the selection somewhere.
        for (const key of Object.keys(persisted)) {
            if (/school|account|center|site/i.test(key)) {
                try {
                    report[`persist_${key}`] = redact(JSON.parse(persisted[key]));
                } catch {
                    report[`persist_${key}`] = redact(persisted[key]);
                }
            }
        }
    } catch (err) {
        console.error("Not signed in on this page, or the session moved. Sign in and retry.", err);
        return;
    }

    // Other localStorage keys that might hold the selected school.
    report.other_localStorage_keys = Object.keys(localStorage).filter((k) => k !== "persist:kinderlime");

    /**
     * @param {string} path
     * @returns {Promise<{status: number, body?: *}>}
     */
    const probe = async (path) => {
        try {
            const res = await fetch(`https://${apiHost}${path}`, {
                headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return { status: res.status };
            return { status: res.status, body: await res.json() };
        } catch (err) {
            return { status: `error: ${err.message}` };
        }
    };

    // --- 2. How many kids does this session see right now? ---------------
    const kidsRes = await probe("/api/web/parent/kids/");
    const kids = kidsRes.body?.kids || [];
    report.kids = {
        status: kidsRes.status,
        count: kids.length,
        field_names: Object.keys(kids[0] || {}),
        // Per-kid: just the identifiers that tell us about school scoping.
        school_scoping: kids.map((k) => ({
            has_school_object: typeof k.school === "object",
            school_keys: k.school && typeof k.school === "object" ? Object.keys(k.school) : undefined,
            school_id: k.school_id ?? k.school?.id,
        })),
        sample_redacted: redact(kids[0] || null),
    };

    // --- 3. Is there an endpoint that lists all schools? -----------------
    // Status codes only - we don't dump these bodies unless they look useful.
    // `parent/photos/` is the gallery feed. It's a real endpoint (confirmed by
    // eyedocnyc/procare-downloader) and it carries photos that never produce an
    // activity record, so the activity feed alone misses them.
    const candidates = [
        "/api/web/parent/photos/",
        "/api/web/parent/schools/",
        "/api/web/parent/accounts/",
        "/api/web/parent/centers/",
        "/api/web/parent/kids/?all=true",
        "/api/web/parent/galleries/",
        "/api/web/parent/media_files/",
    ];
    report.endpoint_probe = {};
    for (const path of candidates) {
        const res = await probe(path);
        report.endpoint_probe[path] = typeof res.status === "number" && res.status === 200
            ? { status: 200, top_level_keys: Object.keys(res.body || {}), shape: redact(res.body) }
            : { status: res.status };
    }

    // --- 4. The gallery feed, called properly ----------------------------
    // A bare GET on parent/photos/ returns 400 because it requires its filter
    // params. Ask it the way the portal's gallery does before concluding the
    // endpoint isn't there.
    {
        const now = new Date();
        const from = `${now.toISOString().slice(0, 7)}-01`;
        const to = now.toISOString().slice(0, 10);
        report.gallery_feed = {};
        for (const resource of ["photo", "video"]) {
            const params = new URLSearchParams({
                page: "1",
                [`filters[${resource}][datetime_from]`]: `${from} 00:00`,
                [`filters[${resource}][datetime_to]`]: `${to} 23:59`,
            });
            const res = await probe(`/api/web/parent/photos/?${params}`);
            report.gallery_feed[resource] = {
                status: res.status,
                top_level_keys: res.body ? Object.keys(res.body) : null,
                shape: res.body ? redact(res.body) : undefined,
            };
        }
    }

    // --- 5. Per-kid reach: scoping and history ---------------------------
    //
    // Two questions at once, for every child:
    //
    //  a) SCOPING. These kids span more than one school, but only one is
    //     "current". If a child at the non-selected school returns zero
    //     everywhere, the activity feed is scoped to current_school and the
    //     downloader has to switch schools. If every child returns data, one
    //     run covers them all.
    //
    //  b) HISTORY. Sampling months going back tells us where each child's
    //     data actually starts -- which separates "Procare caps history at a
    //     year" from "this child simply enrolled recently".
    const monthsBack = [0, 1, 3, 6, 12, 18, 24, 36, 48];
    report.per_kid = [];

    for (const kid of kids) {
        const row = { kid_id: kid.id, created_at: kid.created_at, windows: {} };

        for (const back of monthsBack) {
            const d = new Date();
            d.setUTCDate(1);
            d.setUTCMonth(d.getUTCMonth() - back);
            const month = d.toISOString().slice(0, 7);
            const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

            const params = new URLSearchParams({
                kid_id: kid.id,
                "filters[daily_activity][date_from]": `${month}-01`,
                "filters[daily_activity][date_to]": last.toISOString().slice(0, 10),
                page: "1",
            });
            const res = await probe(`/api/web/parent/daily_activities/?${params}`);
            const items = res.body?.daily_activities || [];

            row.windows[month] = {
                status: res.status,
                count: items.length,
                // Which activity types carry media? We only harvest
                // photo_activity/video_activity today, and other tools warn
                // that photos ride along on many other types.
                types: [...new Set(items.map((a) => a.activity_type))],
                with_media: items.filter((a) => {
                    const p = a.activiable || {};
                    return p.main_url || p.video_file_url || p.photo_url || p.url;
                }).length,
            };
        }
        report.per_kid.push(row);
    }

    console.log("===== PROCARE DIAGNOSTIC (safe to share) =====");
    console.log(JSON.stringify(report, null, 2));
    console.log("===== END =====");
    try {
        await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        console.log("Copied to clipboard.");
    } catch {
        console.log("Couldn't auto-copy - right-click the object above and 'Copy object'.");
    }
})();
