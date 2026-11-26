# How Infuse and Kodi read the library total

Research for [issue 7](https://github.com/hidalgofdz/AIOStreams/issues/7), part of the map in [issue 5](https://github.com/hidalgofdz/AIOStreams/issues/5). It checks whether [PR 4](https://github.com/hidalgofdz/AIOStreams/pull/4) is aimed correctly. Researched 2026-11-25. Source links are pinned to the commit that was read.

Every claim carries one of these labels:

- **code**: read in public source code.
- **vendor**: stated by Firecore in its own documentation.
- **observed**: seen in a traffic capture. "Owner capture" is the logging-proxy capture described in PR 4 (Infuse 8.5.11 on macOS, Direct Mode); I re-read both capture files for this note. Other captures are third-party reports and are named.
- **inference**: my conclusion from the above; not confirmed directly.

Infuse is closed source. Nothing below about Infuse is a code claim.

## Verdict

**The fix is aimed correctly.** Infuse in Direct Mode takes the total from the first page of a library and sizes every later request from it. Two independent captures show this (macOS 8.5.11 and tvOS 8.5.8). Infuse never sends `EnableTotalRecordCount`, so the `wantsTotal` guard does not exclude it. A real Jellyfin server returns an exact count in that situation, so Infuse's behaviour is correct against the server it was written for, and the growing estimate is the deviation.

**The wider match catches nothing it should not, as far as public sources show.**

- `infuse` matches only Infuse. Its client names are `Infuse-Direct`, `Infuse-Library`, `Infuse-Download`, and `Infuse` before version 7.7. No other client in the public client lists has "infuse" in its name.
- Adding the User-Agent to the Kodi test changes nothing for the two Kodi add-ons. Jellyfin for Kodi already matched by client name (`Kodi`), and JellyCon already matched by client name (`Kodi JellyCon`). The only new catch is a request sent through Kodi's own HTTP stack (User-Agent `Kodi/<version> (...)`) by an add-on whose client name lacks "kodi". The one example found, Kofin PVR, does not list `/Items`.

Three things the owner should know before relying on this:

1. **Only Direct Mode is confirmed.** Library Mode (background sync) pages differently, and no capture of it against this fix exists.
2. **Infuse's request timeout is unknown.** No Firecore statement or capture gives it. The exact walk makes the first page slower, so this is the open risk.
3. **The PR test comment may be wrong about the header.** It says Infuse "names itself only in its user agent". Firecore documents `Client="Infuse-Direct"` in `X-Emby-Authorization`. The owner capture did not record that header, so which one holds for 8.5.11 is unverified. The regex matches either way.

## 1. Infuse

### Does it read the total only from the first page?

Yes, in Direct Mode.

- **observed (owner capture, macOS 8.5.11, before the fix):** a library of 216 series answered `0/50 -> total 117`, `50/50 -> total 163`, `100/17 -> total 145`. The third request asked for 17 items, which is 117 minus 100. Infuse ignored the 163 on the second page and stopped at the 117 from the first.
- **observed (owner capture, after the fix):** with a first-page total of 175 the last request was `150/25`; with 216 it was `200/16`. Infuse also jumped from `startIndex=0` straight to 150 and to 200 without requesting the pages between. So the total sizes a list up front, and Infuse then fetches the windows it needs.
- **observed (third party, tvOS 8.5.8):** [aiometadata issue 878][aiom878] reports the same against another Jellyfin-compatible server: totals of 100, 150, 200 on successive pages, and Infuse sent two requests of 50 and stopped at 100. The reporter notes the issue text was drafted with an AI assistant and reviewed by them. The maintainers' fix in [aiometadata PR 900][aiom900] states they could not confirm the read-once behaviour without an Infuse client.
- **vendor:** none. Firecore documents no paging behaviour.

### Does background library sync page differently from browsing?

Yes, by the evidence available, but it is thin and not from this fix.

Infuse has two modes ([Firecore: Streaming from Plex, Emby, and Jellyfin][fc-stream], **vendor**). Direct Mode fetches "on an as-needed basis, on-the-fly". Library Mode caches server data on the device and rescans when the app opens, every 15 minutes while open, and hourly in the background. Direct Mode is the default since 7.7 ([Firecore: Connection Info][fc-conn], **vendor**).

| | Direct Mode | Library Mode |
|---|---|---|
| Path | `/Items` | `/Users/{id}/Items` |
| Parameter case | `startIndex`, `limit`, `parentId` | `StartIndex`, `Limit`, `ParentId` |
| Page size | 50; last page shortened to `total - startIndex` | 200 for the episode crawl, in order: 0, 200, 400 |
| Scope | one library, `includeItemTypes=Movie` or `Series` | also library-wide recursive `Season` and `Episode` queries |
| Source | **observed**, owner capture | **observed**, third party: [jellyfin issue 7921][jf7921] (server log, Infuse 7.3.10, 2022) and [upstream AIOStreams issue 1432][up1432] |

The Infuse log quoted in upstream issue 1432 reads `shows: fetched 250/250 items`, `seasons: fetched 0/0`. That is a fetched-over-total counter, so Library Mode also tracks a total (**inference**). Whether it reads that total once is not shown anywhere.

The stop condition in Direct Mode is the first-page total (**observed**). The stop condition in Library Mode is unverified.

With the InfuseSync plugin installed, Library Mode syncs through the plugin's own `InfuseSync/Checkpoint/...` routes ([firecore/InfuseSync controller][infusesync], **code**). AIOStreams does not serve those routes (no match for "infusesync" in `packages/`), so Library Mode against AIOStreams does its ordinary scan (**inference**).

### What request timeout applies, and what happens on a slow first page?

**Not found.** Neither Firecore article mentions a timeout, and no Firecore staff post found gives one. A [Firecore forum thread on slow Jellyfin 10.11 loading][fc-slow] has staff asking for diagnostics only. Users there report Library Mode fetches running for minutes in total, which says nothing about the limit on a single request.

The owner capture logs only when a reply ends, so it gives no latency either. What Infuse shows when a first page is slow or times out is unverified. This needs a measurement: delay the first page at the proxy and watch the client.

### What client name and User-Agent does it send?

- **vendor ([Firecore: Connection Info][fc-conn], updated 2026-05-06):** for Emby and Jellyfin, Infuse-Direct sends

  ```
  X-Emby-Authorization: MediaBrowser Token="#####", Client="Infuse-Direct", Version="7.7", Device="####", DeviceId="###-#-###"
  User-Agent: Infuse-Direct/7.7
  ```

  The article names three connection types: `Infuse-Direct`, `Infuse-Library` and `Infuse-Download` (offline downloads). It gives header examples only for Infuse-Direct. "In versions prior to 7.7, a connection type of 'Infuse' was used for all requests." The article does not distinguish platforms.
- **observed, macOS:** `User-Agent: Infuse-Direct/8.5.11` on all 489 Infuse requests in the owner capture. The capture did not record the authorization header, so the client name on macOS is not directly confirmed.
- **observed, tvOS (third party):** `User-Agent: Infuse-Direct/8.5.8` ([aiometadata issue 878][aiom878]).
- **iOS:** no capture found. The User-Agent carries no platform token on macOS or tvOS, so the same string is expected (**inference**).
- **Library Mode and downloads:** `Infuse-Library/<version>` and `Infuse-Download/<version>` by the pattern in Firecore's article (**inference**; the article shows no header for them).

All of these contain "infuse", in the client name and in the User-Agent.

### How the repo already detects Infuse

`wantsListVersions` in `packages/server/src/routes/jellyfin/context.ts` (line 450 on `main` at `89f03f6f1`) tests `/infuse/i` against the client name and the User-Agent joined by a space:

```ts
return /infuse/i.test(`${client.name} ${req.get('user-agent') ?? ''}`);
```

`images.ts` (line 112) uses the same pattern to relay artwork for Infuse. The client name comes from `extractAuth` in `packages/core/src/jellyfin/auth.ts`, which reads `Authorization` and falls back to `X-Emby-Authorization`; with neither it is `Unknown`. PR 4's `readsTotalOnce` follows the same shape with `/kodi|infuse/i`.

## 2. Kodi add-ons

### Jellyfin for Kodi

- **How it reads the total (code):** once, from a dedicated probe. [`_get_items`][kodi-dl] copies the query, sets `Limit=1` and `EnableTotalRecordCount=True`, and reads `TotalRecordCount`. It then builds every page offset up front with `range(StartIndex, TotalRecordCount, limit)` and fetches the pages on a thread pool. The page queries themselves carry `EnableTotalRecordCount: False` ([`get_items`][kodi-getitems]). `get_item_count` does the same probe for progress bars.
- **Page size and concurrency (code):** `min(limitIndex setting or 50, 50)` items per page, `limitThreads` (default 3) requests in parallel ([`_get_items`][kodi-dl]).
- **Timeout (code):** 30 seconds by default ([`DEFAULT_HTTP_TIMEOUT`][kodi-timeout]). If the probe fails, the exception is logged and nothing is synced for that query.
- **Client name and User-Agent (code):** client name `Kodi`, User-Agent `Jellyfin-Kodi/<version>` ([`get_client`][kodi-client]), sent in an `Authorization: MediaBrowser Client=Kodi, ...` header ([`http.py`][kodi-http]).

Consequence for the fix: the only request that has `EnableTotalRecordCount` on is the `Limit=1` probe, so `wantsTotal && readsTotalOnce` gives Kodi the exact walk on the probe and never on the page requests. That is unchanged by PR 4.

### JellyCon

- **How it reads the total (code):** mostly on every page. A directory listing stores `TotalRecordCount` from each page it loads ([`datamanager.py`][jcon-dm]) and offers "Next Page" while `start_index + page_size < total_records` ([`dir_functions.py`][jcon-dir]). A growing estimate works with that. One menu reads it once: [`show_movie_pages`][jcon-pages] sends a single request with no `Limit` and builds one menu entry per page from that total. Many of its other queries send `EnableTotalRecordCount: False`.
- **Timeout (code):** 5 seconds to connect, 60 seconds to read ([`jellyfin.py`][jcon-timeout]).
- **Client name and User-Agent (code):** `Authorization: MediaBrowser Client="Kodi JellyCon", ...` ([`jellyfin.py`][jcon-client]). It sets no User-Agent, so the `requests` library default (`python-requests/<version>`) is sent (**inference** from the absence of any User-Agent header in the add-on).

### Does matching the User-Agent change which Kodi requests are caught?

Not for these two add-ons.

| Add-on | Client name | User-Agent | Old `/kodi/i` on name | New match |
|---|---|---|---|---|
| Jellyfin for Kodi | `Kodi` | `Jellyfin-Kodi/<version>` | caught | caught |
| JellyCon | `Kodi JellyCon` | `python-requests/<version>` | caught | caught |

The User-Agent adds one class of request: anything sent through Kodi's own HTTP stack. Kodi builds its User-Agent as `Kodi/<version> (<platform>...)` ([`CSysInfo::GetUserAgent`][xbmc-ua], **code**). Kodi itself fetches artwork and streams that way, but those are not `/Items` listings, and `readsTotalOnce` is only consulted in the `/Items` handler. So the new catch is limited to an add-on that lists `/Items` through Kodi's HTTP stack under a client name without "kodi" (**inference**). None was found.

## 3. Other clients newly caught

None that matter, from the sources checked.

- **"infuse":** the Jellyfin project's client list ([`clients.ts`][jf-clients], **code**) has no entry containing "infuse". The community list [awesome-jellyfin][awesome] has one: Infuse itself. Of the open-source clients read for section 4, none has "infuse" in its client name.
- **"kodi" in the client name:** only the Kodi add-ons (`Kodi`, `Kodi JellyCon`), both already caught before PR 4.
- **"kodi" in the User-Agent only:** [Kofin PVR][kofin], a Jellyfin live-TV add-on for Kodi, declares `Client="Kofin PVR", Device="Kodi"`. Device is not tested, so the name does not match. If it sends Kodi's User-Agent it is newly matched (**inference**; its User-Agent was not confirmed), but a search of its client code found only an image URL under `/Items`, no library listing.

Not ruled out: a client that lets the user set a custom name or User-Agent, and closed-source clients not on either list.

For comparison, the client names of the mainstream clients (**code**): [`Jellyfin Web`][web-name], [`Swiftfin iOS` / `Swiftfin tvOS`][swift-name], [`Jellyfin for Android TV`][atv-name], [`Jellyfin for Android`][and-name], [`Streamyfin`][streamy-name], and Findroid's app label ([`JellyfinApi.kt`][find-name]). The Kotlin SDK clients send `<client name>/<version> via jellyfin-sdk-kotlin (OkHttp/...)` as User-Agent ([`OkHttpClient.kt`][sdk-ua]). None contains "kodi" or "infuse".

## 4. Real Jellyfin, and whether other clients truncate

### Is `TotalRecordCount` exact on a real server?

Yes, whenever `EnableTotalRecordCount` is not false (**code**).

- `enableTotalRecordCount` defaults to `true` on `GET /Items` ([`ItemsController.cs`][jf-ctrl]).
- With it on, the repository runs the filtered query through `dbQuery.Count()` before paging and returns that as the total ([`BaseItemRepository.Querying.cs`][jf-repo]). A request with no `Limit` and `StartIndex` 0 returns the whole list, and the total is its length.
- With it off, the total is the number of items on the returned page ([`QueryResult`][jf-qr] falls back to `items.Count`; [`LibraryManager.QueryItems`][jf-lm] passes no count).

So a real server gives the same exact total on every page, and a client that reads it once is safe there. A total that changes between pages is specific to AIOStreams' estimate.

### Which clients read the total once?

None of the open-source clients checked. All re-read it on every page or ignore it (**code**).

| Client | Stop condition | Reads total | Truncated by a growing estimate? |
|---|---|---|---|
| Swiftfin | [`LibraryPageState.progress`][swift-page]: next page while `nextOffset < totalRows`, with `totalRows` reset from each response; falls back to "page was full" | every page | no |
| jellyfin-web | Next button enabled while `startIndex + limit < totalRecordCount`, rebuilt from each page's result ([legacy][web-legacy], [`libraryBrowser.js`][web-lb]; [modern toolbar][web-modern]) | every page | no |
| Jellyfin for Android | wraps jellyfin-web; no total handling in native code | as jellyfin-web | no |
| Android TV | [`retrieveItems`][atv-helper] sets `totalItems` from each response; [`fullyLoaded = itemsLoaded >= totalItems`][atv-adapter] | every page | no |
| Findroid | [`ItemsPagingSource`][find-page]: next page until a page comes back empty | never | no |
| Streamyfin | [`getNextPageParam`][streamy-page]: more while the items loaded so far are fewer than the last page's `TotalRecordCount` | every page | no |
| JellyCon | per page, except the "movie pages" menu (section 2) | every page, one menu once | already gets the exact total |
| Jellyfin for Kodi | probe (section 2) | once | already gets the exact total |
| Infuse (Direct Mode) | first-page total (**observed**) | once | yes, fixed by PR 4 |

"No" in the last column is **inference** from the stop condition: an estimate of "walked so far plus one page" always exceeds what the client has loaded until the catalog ends, so these clients keep paging. They were not run against AIOStreams for this note.

So the truncation is specific to clients that fix the list size up front. Among mainstream clients that is Infuse and Jellyfin for Kodi. Other closed-source clients were not examined.

## 5. Does Infuse send `EnableTotalRecordCount`?

No (**observed**). None of the 23 `/Items` requests from Infuse 8.5.11 in the owner capture carries it, and neither do its 7 `/Playlists/{id}/Items` requests. The parameters it sends on `/Items` are `userId`, `startIndex`, `limit`, `fields`, `excludeLocationTypes`, `parentId`, `recursive`, `sortBy`, `sortOrder` and `includeItemTypes`. The Direct Mode requests quoted in [aiometadata issue 878][aiom878] (tvOS) and the Library Mode requests in [jellyfin issue 7921][jf7921] (2022) do not carry it either.

With the parameter absent, `wantsTotal` in `library.ts` is true, so the fix applies. No source shows Infuse sending `false`. Library Mode on a current version was not captured.

## Not verified

- Infuse's request timeout, and what it shows when the first page is slow or fails.
- Infuse's client name in the authorization header on any platform, by capture. Firecore's article is the only source.
- Infuse on iOS, by capture.
- Library Mode on a current Infuse version: its User-Agent, page size, whether it reads the total once, and whether it sends `EnableTotalRecordCount`.
- Whether Kofin PVR sends Kodi's User-Agent.
- That the clients in section 4 page correctly against AIOStreams' estimate in practice.
- Closed-source clients other than Infuse.

A capture proxy that also records the `authorization` and `x-emby-authorization` headers, with the token removed, would settle the second item and, with Library Mode switched on, most of the fourth.

[aiom878]: https://github.com/cedya77/aiometadata/issues/878
[aiom900]: https://github.com/cedya77/aiometadata/pull/900
[up1432]: https://github.com/Viren070/AIOStreams/issues/1432
[jf7921]: https://github.com/jellyfin/jellyfin/issues/7921
[fc-conn]: https://support.firecore.com/hc/en-us/articles/21072505575319-Connection-Info-for-Emby-Jellyfin-and-Plex
[fc-stream]: https://support.firecore.com/hc/articles/360006462093
[fc-slow]: https://community.firecore.com/t/poor-series-loading-times-with-jellyfin-10-11/57511
[infusesync]: https://github.com/firecore/InfuseSync/blob/273bd0cb8ce455ccdb0242ecfc48fd951aa1c03c/InfuseSync/API/InfuseSyncController.cs#L56-L215
[kodi-dl]: https://github.com/jellyfin/jellyfin-kodi/blob/0a13093cf3fe2701ea5f6c36753d80b994e4bea5/jellyfin_kodi/downloader.py#L194-L240
[kodi-getitems]: https://github.com/jellyfin/jellyfin-kodi/blob/0a13093cf3fe2701ea5f6c36753d80b994e4bea5/jellyfin_kodi/downloader.py#L128-L170
[kodi-timeout]: https://github.com/jellyfin/jellyfin-kodi/blob/0a13093cf3fe2701ea5f6c36753d80b994e4bea5/jellyfin_kodi/jellyfin/configuration.py#L15
[kodi-client]: https://github.com/jellyfin/jellyfin-kodi/blob/0a13093cf3fe2701ea5f6c36753d80b994e4bea5/jellyfin_kodi/connect.py#L75-L85
[kodi-http]: https://github.com/jellyfin/jellyfin-kodi/blob/0a13093cf3fe2701ea5f6c36753d80b994e4bea5/jellyfin_kodi/jellyfin/http.py#L227-L262
[jcon-dm]: https://github.com/jellyfin/jellycon/blob/28dafd4321c2516a5756f45404b6d3b4ebe9ff03/resources/lib/datamanager.py#L95-L127
[jcon-dir]: https://github.com/jellyfin/jellycon/blob/28dafd4321c2516a5756f45404b6d3b4ebe9ff03/resources/lib/dir_functions.py#L135-L174
[jcon-pages]: https://github.com/jellyfin/jellycon/blob/28dafd4321c2516a5756f45404b6d3b4ebe9ff03/resources/lib/menu_functions.py#L186-L260
[jcon-timeout]: https://github.com/jellyfin/jellycon/blob/28dafd4321c2516a5756f45404b6d3b4ebe9ff03/resources/lib/jellyfin.py#L41
[jcon-client]: https://github.com/jellyfin/jellycon/blob/28dafd4321c2516a5756f45404b6d3b4ebe9ff03/resources/lib/jellyfin.py#L102-L143
[xbmc-ua]: https://github.com/xbmc/xbmc/blob/f9b135bf111e8987873fbe2d695cc73a6e76a833/xbmc/utils/SystemInfo.cpp#L1213-L1219
[kofin]: https://github.com/kodi-pvr/pvr.kofin/blob/9236e17fc4e818370918f07cd3747653a8be4c55/src/iptvsimple/jellyfin/JellyfinClient.cpp#L53
[jf-clients]: https://github.com/jellyfin/jellyfin.org/blob/7edbf8735642e677f8113efcb8fe345d6941b433/src/data/clients.ts
[awesome]: https://github.com/awesome-jellyfin/awesome-jellyfin
[jf-ctrl]: https://github.com/jellyfin/jellyfin/blob/6b786b36eed49bf83860d9b652b96f475aeb2668/Jellyfin.Api/Controllers/ItemsController.cs#L260
[jf-repo]: https://github.com/jellyfin/jellyfin/blob/6b786b36eed49bf83860d9b652b96f475aeb2668/Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs#L31-L64
[jf-qr]: https://github.com/jellyfin/jellyfin/blob/6b786b36eed49bf83860d9b652b96f475aeb2668/MediaBrowser.Model/Querying/QueryResult.cs#L36-L41
[jf-lm]: https://github.com/jellyfin/jellyfin/blob/6b786b36eed49bf83860d9b652b96f475aeb2668/Emby.Server.Implementations/Library/LibraryManager.cs#L1911-L1925
[swift-page]: https://github.com/jellyfin/Swiftfin/blob/35a5f35812deb9838dfc69b6554a6a3f935797d1/Shared/Objects/PagingLibrary/PagingLibrary.swift#L33-L59
[swift-name]: https://github.com/jellyfin/Swiftfin/blob/35a5f35812deb9838dfc69b6554a6a3f935797d1/Shared/Extensions/JellyfinAPI/JellyfinClient.swift#L20
[web-legacy]: https://github.com/jellyfin/jellyfin-web/blob/0ba6ca616421c9a11058ce197f78fb2a60af89e1/src/apps/legacy/controllers/movies/movies.js#L63-L92
[web-lb]: https://github.com/jellyfin/jellyfin-web/blob/0ba6ca616421c9a11058ce197f78fb2a60af89e1/src/scripts/libraryBrowser.js#L43-L63
[web-modern]: https://github.com/jellyfin/jellyfin-web/blob/0ba6ca616421c9a11058ce197f78fb2a60af89e1/src/apps/modern/features/libraries/components/LibraryToolbar.tsx#L65-L93
[web-name]: https://github.com/jellyfin/jellyfin-web/blob/0ba6ca616421c9a11058ce197f78fb2a60af89e1/src/components/apphost.js#L11
[atv-helper]: https://github.com/jellyfin/jellyfin-androidtv/blob/dbfbfa4b6b6cdc8bbe1086ebeca7fba0ead3f882/app/src/main/java/org/jellyfin/androidtv/ui/itemhandling/ItemRowAdapterHelper.kt#L562-L579
[atv-adapter]: https://github.com/jellyfin/jellyfin-androidtv/blob/dbfbfa4b6b6cdc8bbe1086ebeca7fba0ead3f882/app/src/main/java/org/jellyfin/androidtv/ui/itemhandling/ItemRowAdapter.java#L350-L352
[atv-name]: https://github.com/jellyfin/jellyfin-androidtv/blob/dbfbfa4b6b6cdc8bbe1086ebeca7fba0ead3f882/app/src/main/java/org/jellyfin/androidtv/di/AppModule.kt#L89-L93
[and-name]: https://github.com/jellyfin/jellyfin-android/blob/fcf4b8aaafe87e3aaaa03a5273f1d13354729ff3/app/src/main/java/org/jellyfin/mobile/utils/Constants.kt#L11
[find-page]: https://github.com/jarnedemeulemeester/findroid/blob/b88c72203f558e499a06f1917648a807ffedb5b9/data/src/main/java/dev/jdtech/jellyfin/repository/ItemsPagingSource.kt#L20-L44
[find-name]: https://github.com/jarnedemeulemeester/findroid/blob/b88c72203f558e499a06f1917648a807ffedb5b9/data/src/main/java/dev/jdtech/jellyfin/api/JellyfinApi.kt#L41-L48
[streamy-page]: https://github.com/streamyfin/streamyfin/blob/662e011d619fa8ad94615ecabd6a9d1c22f5ca01/app/%28auth%29/%28tabs%29/%28libraries%29/%5BlibraryId%5D.tsx#L733-L751
[streamy-name]: https://github.com/streamyfin/streamyfin/blob/662e011d619fa8ad94615ecabd6a9d1c22f5ca01/providers/JellyfinProvider.tsx#L169
[sdk-ua]: https://github.com/jellyfin/jellyfin-sdk-kotlin/blob/fd742cb676a98b3783c2a92f79286eb0229be773/jellyfin-api-okhttp/src/jvmMain/kotlin/org/jellyfin/sdk/api/okhttp/OkHttpClient.kt#L120
