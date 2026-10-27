# Third-party content

Where the maps, pictures, listings and data that BoilerIndy shows come from,
how each reaches the student, and the terms it is used under, with the open
questions the owner still has to settle (issue #530). Code credits (fonts and
icons) are in the root `NOTICE`.

## What the app shows

| Content | Source | How it reaches the student | Terms and credit |
| --- | --- | --- | --- |
| Map tiles on `/map`, `/guide` and `/transit` | Esri ArcGIS Online basemaps (`server.arcgisonline.com`), see `pages/Map.tsx` (issue #160) | The browser loads the tiles straight from Esri, so Esri sees the IP address | "Powered by Esri" and the data sources, with OpenStreetMap linked, in every map's attribution (`ESRI_TILE_ATTRIBUTION` in `components/map/mapChrome.ts`). Open question below. |
| Campus building outlines on `/map` | Purdue's `Indianapolis_Building_Shapes` feature service on ArcGIS Online (`services1.arcgis.com`) | The browser queries it directly (allowed in the CSP `connect-src`) | Public layer, read only. |
| Dining menus and dish photos | Nutrislice's public menu API ([dining.md](dining.md)) | Menus through our server; dish photos load from Nutrislice's image host | No written permission on record. |
| Club directory and club logos | BoilerLink's public organizations search ([clubs.md](clubs.md)) | Directory through our server; logos load from BoilerLink | No written permission on record. |
| Campus and downtown events | Purdue's and IU's public calendars, White River State Park, Ticketmaster ([shared-campus-events.md](shared-campus-events.md)) | Through our server | Ticketmaster's API terms bar revenue from pages its listings reach, so `/events` and `/free-food` carry no ads (`lib/adFreeRoutes.ts`). |
| Campus news | The Circuit, Purdue Indy's student newspaper ([campus-news.md](campus-news.md)) | Through our server | Headlines, excerpts and links only. |
| Parking garages | IU's public garage status page ([parking-status.md](parking-status.md)) | Through our server | Public page, read only. |
| Shuttle positions | TransLoc's JagLine feed | Through our server | Public feed. |
| Sponsor images | The image link each advertiser gives (`imageUrl`, `imageUrls`) | The browser loads it from the advertiser's host | Advertisers are approved by hand; no written warranty that they own the image. |

## Open questions (owner)

- **Esri tiles without a key.** The tiles come from Esri's keyless legacy
  endpoint. Esri's developer documentation expects an ArcGIS account or API
  key for basemap use; ArcGIS Location Platform has a free tier. Decide
  whether to move to a key or to another tile provider before the public beta.
- **Nutrislice and BoilerLink images.** Both are public, but neither has been
  asked. If either objects, the dish photos and club logos can fall back to
  text with no other change.
- **Sponsor images.** Hosting them ourselves (as marketplace photos are) would
  keep the advertiser's host from seeing who viewed the ad, and an advertiser
  terms page could carry the warranty that they own what they upload.
