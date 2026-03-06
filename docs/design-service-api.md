# Design Service API — MakerWorld Integration

> Complete API reference for the MakerWorld 3D model platform  
> Base URL: `https://api.bambulab.com/v1/design-service`  
> Also accessible via: `https://makerworld.com/api/v1/design-service`

## Overview

The Design Service manages 3D models ("designs") on MakerWorld. Each design has:

- **Design** — the top-level model page (title, description, images, creator)
- **Instances** — specific print configurations (plate layouts, slicer settings)
- **3MF files** — downloadable print-ready files linked to instances

## Endpoints

### Get Design Details

```
GET /design-service/design/{designId}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `designId` | path | yes | Numeric design ID |
| `trafficSource` | query | no | Analytics source: `browse`, `recommend`, `search` |
| `visitHistory` | query | no | `true` to log page visit |

**Response includes:**
- `id` — design ID
- `title` — design title
- `designCreator` — `{ name, uid, avatar }`
- `instances[]` — array of print instances
  - `id` — instance ID (needed for download)
  - `isDefault` — boolean
  - `title` — instance name
  - `plates[]` — plate configurations
- `tags[]` — category tags
- `likeCount`, `downloadCount`, `commentCount`
- `images[]` — gallery image URLs

### Get Remixes

```
GET /design-service/design/{designId}/remixed
```

Returns designs that are remixes of the given design.

### Like a Design

```
POST /design-service/design/{designId}/like
```

Toggle like status. No request body needed.

### Download 3MF

```
GET /design-service/instance/{instanceId}/f3mf
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `instanceId` | path | Instance ID from design details |
| `type` | query | `preview` (metadata) or `download` (full file) |

**Download flow:**
1. Fetch design details → get default instance ID
2. Call with `type=download` → receive 3MF binary

### User's Favorites

```
GET /design-service/favorites/designs/{userId}?offset=0&limit=20
```

Get a specific user's public favorites.

### Check Favorites Status

```
GET /design-service/my/design/favoriteslist?designId={designId}
```

Check if a design is in the current user's favorites list.

### Get Liked Designs

```
GET /design-service/my/design/like?offset=0&limit=20
```

Get designs the current user has liked.

### Favorites List (Lightweight)

```
GET /design-service/my/favorites/listlite
```

Returns just the design IDs of all favorites (no full design objects).

### Draft Slice Errors

```
GET /design-service/draft/sliceerror
```

Get drafts that had slicing errors (for the MakerWorld design workflow).

## Integration with MakerWorld Web

The same API is used by both the Bambu Handy app and the MakerWorld website.

- **App**: `https://api.bambulab.com/v1/design-service/...`
- **Web**: `https://makerworld.com/api/v1/design-service/...`

The web version is protected by Cloudflare (requires browser cookies), while the app uses JWT Bearer tokens.

## Complete Print Workflow

```
1. Search/browse → GET /search-service/select/design/nav?navKey=Trending
2. View design → GET /design-service/design/{designId}
3. Check favorite → GET /design-service/my/design/favoriteslist?designId={id}
4. Get ratings → GET /comment-service/commentandrating?designId={id}
5. Download 3MF → GET /design-service/instance/{instanceId}/f3mf?type=download
6. Upload to printer → FTP to printer SD card
7. Start print → MQTT command on device/{serial}/request
```
