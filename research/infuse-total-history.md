# Was the estimated total always the behaviour for Infuse?

Research for [issue 6](https://github.com/hidalgofdz/AIOStreams/issues/6), part of the map in [issue 5](https://github.com/hidalgofdz/AIOStreams/issues/5). Researched 2026-11-25 against `main` at `89f03f6f1` and upstream `Viren070/AIOStreams`.

Each claim is marked **Verified** (read directly in the cited source) or **Inferred** (a conclusion drawn from verified facts).

## Verdict

**A long-standing gap, not a regression.** No commit and no released version of AIOStreams ever gave Infuse an exact `TotalRecordCount`. The estimate `offset + opts.limit` and the Kodi-only `exactTotal` flag both arrived in the very first commit of the Jellyfin API and neither line has been edited since.

- Affected range: every stable release with the Jellyfin API, **v2.35.0 (2026-09-26) through v2.38.1 (2026-11-14)**, plus current `main`. Nightly builds from 2026-09-09 onward carry the same code (first affected nightly not pinned down).
- The fix in [PR 4](https://github.com/hidalgofdz/AIOStreams/pull/4) does not revert any earlier change. What it does cut against is a design preference visible in the code: walk a catalog only as far as the request needs.

## 1. What a non-Kodi client received, from the first commit on

**Verified.** The Jellyfin API was added in one commit, [`dd8ea9c36`](https://github.com/Viren070/AIOStreams/commit/dd8ea9c36bd6853a3661669940350bbbaeb341c5) (Viren070, 2026-09-09). It was pushed directly; the GitHub API lists no pull request for it. In that commit:

| What | Where at `dd8ea9c36` |
|---|---|
| `exactTotal?: boolean`, documented "Walk to the end (or the cap) so the total is exact." | `packages/core/src/jellyfin/library.ts:63-64` |
| Walk stops once the page is full unless `exactTotal` | `packages/core/src/jellyfin/library.ts:215` |
| `const total = done ? Math.min(offset, cap) : offset + opts.limit;` | `packages/core/src/jellyfin/library.ts:284` |
| `isKodi(ctx)` = `/kodi/i.test(ctx.client.name)` | `packages/server/src/routes/jellyfin/library.ts:54-56` |
| `wantsTotal(req)` = `EnableTotalRecordCount !== false` | `packages/server/src/routes/jellyfin/library.ts:200-202` |
| `exactTotal: isKodi(ctx) && wantsTotal(req)` (the only call site then) | `packages/server/src/routes/jellyfin/library.ts:491` |

So a non-Kodi client received, from day one: the exact count if the walk happened to reach the end of the catalog or the `JELLYFIN_MAX_CATALOG_ITEMS` cap while filling the requested page, and otherwise `offset + limit`, where `offset` is the number of entries read so far (rounded up to whole addon pages).

**Verified: the formula was never different.**

- `git log -L` on the `const total = ...` line returns exactly one commit, `dd8ea9c36`. The line is byte-identical on `main` (`packages/core/src/jellyfin/library.ts:387`).
- `git log -S'offset + opts.limit'` returns two commits: `dd8ea9c36` and [`6be31e077`](https://github.com/Viren070/AIOStreams/commit/6be31e077fe5b06bcc327709d06f79df9ff3054f) (2026-09-16). The second only *copies* the same formula into the new `collectionMembers` function and adds the second call site, again as `isKodi(ctx) && wantsTotal(req)`.
- `git log -G'exactTotal|isKodi|wantsTotal|hasMore'` over both Jellyfin directories returns six commits. None changes who gets an exact total:
  - `dd8ea9c36` introduces everything.
  - `6be31e077` adds the collections call site (Kodi only).
  - `a0e34a653` (2026-10-18) and `e65bf17d3` (2026-11-20) touch neighbouring code.
  - [`71603f4dc`](https://github.com/Viren070/AIOStreams/commit/71603f4dc8b1940ba1bb31094fd212622931ef5a) (2026-11-13) adds an abort signal and a background lane to walks.
  - [`3602f0ea6`](https://github.com/Viren070/AIOStreams/commit/3602f0ea670cf58c7e1d38d5182669b7f4c67977) (2026-11-20) adds `mixedMembers` for interleaved collections, with the same pattern (`target = opts.exactTotal ? Infinity : end`, estimate `out.length + opts.limit`).
- The relevant lines are the same at the three release tags checked: `v2.35.0` (`154be8798`), `v2.35.9` (`1dcfa7665`) and `v2.38.1` (`113ab6bfd`).

**Verified: first released version.** The GitHub compare API shows `v2.34.1` does not contain `dd8ea9c36` and `v2.35.0` does. `CHANGELOG.md` lists the commit under 2.35.0 (line 1137), alongside `6be31e077` (line 1138). `3602f0ea6` is not in `v2.38.1`; it is on `main` and in nightlies only.

### How Infuse was meant to see a whole library without an exact total

**Verified.** The description of `JELLYFIN_MAX_CATALOG_ITEMS` has read, unchanged since `dd8ea9c36` (`packages/core/src/config/schema/jellyfin.ts:70`): "Library crawlers (Infuse sync, Kodi) walk every library to this cap". So the maintainer expected Infuse to reach the cap.

**Inferred.** The estimate is a rolling "there is more" signal. A non-exact walk only stops once `offset >= startIndex + limit`, so the estimate is always larger than the end of the page just served. A client that re-reads `TotalRecordCount` on every page keeps asking until the walk is `done`, at which point the total becomes exact. The PR 4 capture shows this shape: totals of 117, 163, 145 on successive pages of a 216-item library. The design works for clients that follow the moving total and fails for clients that read it once. Nothing in the history says which kind the maintainer believed Infuse to be; the config text suggests they assumed it would follow.

## 2. Why Kodi gets the exact total

**Verified: the reason is not written down anywhere.** `isKodi` has no comment. The commit message of `dd8ea9c36` is two subject lines with no body. There is no PR and no linked issue. No commit, comment or doc mentions Infuse in connection with totals, and none records a decision to withhold the exact total from other clients.

**Verified: how Jellyfin for Kodi pages.** In [`jellyfin_kodi/downloader.py`](https://github.com/jellyfin/jellyfin-kodi/blob/0a13093cf3fe2701ea5f6c36753d80b994e4bea5/jellyfin_kodi/downloader.py#L195-L238), `_get_items` first sends the query with `Limit=1` and `EnableTotalRecordCount=True`, stores that `TotalRecordCount`, then fetches `range(StartIndex, TotalRecordCount, limit)`. It reads the total once.

**Inferred.** With the estimate, that probe would answer about 21 (one addon page of 20 plus the limit of 1) and Kodi would sync 21 items per library. That is the likely reason Kodi was special-cased. An upstream commenter measured exactly this number with a `Limit=1` probe (see section 3).

**Verified: the cost design the fix cuts against.** The only reasoning in the code is the comment on `wantsTotal`, present since `dd8ea9c36` (now `packages/server/src/routes/jellyfin/library.ts:348-352`): "a client that never reads the total does not make us walk the catalog for it." The config description quoted above also prices the walk: "each addon page of 20 items is one upstream request". Later commits keep reducing walk cost: [`3278fa6`](https://github.com/Viren070/AIOStreams/commit/3278fa69835f0e95a942158adbe524a0af7d88b2) caps concurrent catalog requests (2.37.0), [`26f6f24`](https://github.com/Viren070/AIOStreams/commit/26f6f24c64432e83a80a5a70bce3c016946a3d4e) stops walks when the client leaves (2.38.0), and `71603f4dc` adds the background lane.

**Inferred.** Limiting the exact walk to Kodi looks like the narrowest exception to a "walk lazily" rule, made for the one client known to need it, rather than a decision against Infuse.

## 3. Upstream issues, PRs, discussions and changelog

Searched `Viren070/AIOStreams` issues and PRs for: infuse, infuse library, infuse missing, TotalRecordCount, exactTotal, kodi, kodi total, kodi sync, StartIndex, jellyfin pagination, jellyfin paging, jellyfin truncated, jellyfin total, JELLYFIN_MAX_CATALOG_ITEMS, maxCatalogItems. Searched discussions for infuse, kodi, TotalRecordCount, jellyfin library. Grepped `CHANGELOG.md` for kodi, infuse, total, crawl.

**Verified findings:**

- **No upstream issue or PR reports Infuse showing a truncated library**, and none proposes changing the total. No discussion matches. `CHANGELOG.md` has no entry mentioning Infuse or Kodi totals, and no entry that changes the total.
- **[Viren070/AIOStreams#1432](https://github.com/Viren070/AIOStreams/issues/1432)** (open, 2026-10-05, v2.35.9, Infuse 8 on macOS) is the closest. Its subject is different: series libraries are empty in Infuse Library Mode because recursive Season/Episode queries answer 0. Two things in it bear on this ticket:
  - A comment by `cver-me` on 2026-10-31, on a nightly build, reports `TotalRecordCount` of 21 for a `Limit=1` series query and says: "looks like a single catalog page rather than the full catalog. Even with episodes fixed, Infuse would only index the first page per library." This is the earliest upstream sighting of the gap. It drew no maintainer reply, and the issue timeline shows no linked commit or PR.
  - The original post quotes an Infuse log line, `shows: fetched 250/250 items`, for libraries of 250 items. See "Not verified" below.
- Other hits are unrelated to library totals: #1976 (Playlists library empty), #1678 (boxset views return 0), #1937 and #1941 (Live TV channel limit of 100), #1905 and #1922 (1000-episode cap in the web app), #1579 (`/Items/Latest` cap), #987 (Infuse subtitles).

## 4. What the fix risks undoing

Nothing in the history is reverted by giving Infuse the exact total. Points worth weighing:

1. **The lazy-walk cost model.** The fix makes Infuse's first page walk to the end or the cap. That is the cost the `wantsTotal` comment and the config description try to avoid, now accepted for a second client. It is the same trade already made for Kodi.
2. **Newer walk paths inherit the flag.** `collectionMembers` (2.35.0) and `mixedMembers` (unreleased, `3602f0ea6`) pass `exactTotal` down; `mixedMembers` reads every source lane to its end when it is set. These paths were only ever exercised with `exactTotal` by Kodi-named clients.
3. **Abort and guard behaviour.** Since `71603f4dc`, an aborted walk ends early with `done` false, so an exact-total request that is cut short falls back to the estimate. The 60-page guard does the same.
4. **Kodi matching widens.** `main` matches Kodi on the client name only. PR 4's description says Kodi is now also matched by user agent. That is a behaviour change for Kodi-like clients that the history gives no precedent for.

## Not verified

- **Whether Infuse's own paging changed between versions.** The `fetched 250/250` log line in #1432 (v2.35.9) does not fit a client that reads a 50-item first page and trusts its total, which is what the PR 4 capture shows for Infuse 8.5.11. On the same server code that first page would report about 110. Possible explanations: an older Infuse used a larger page size (a `Limit` of 250 on a capped 250-item library yields an exact 250), or it re-read the total. If so, the truncation could be a regression on Infuse's side even though the server never changed. No Infuse source or changelog was available to check.
- **The maintainer's actual reason for the Kodi exception.** Inferred from Jellyfin for Kodi's source, not stated by the maintainer.
- **The first affected nightly.** Nightly tags from 2026-09-09 exist; which one first contained `dd8ea9c36` was not checked.
- **Discord or other off-GitHub channels** were not searched.
