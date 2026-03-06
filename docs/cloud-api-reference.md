# Bambu Lab Cloud API Reference

> **Reverse-engineered from Bambu Handy v3.x** (package: `bbl.intl.bambulab.com`)  
> Captured via live traffic interception on March 4, 2026  
> Base URL: `https://api.bambulab.com/v1`

## Authentication

All endpoints require a **Bearer JWT token** in the `Authorization` header.

```http
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
```

Tokens are obtained via Bambu Lab account login (OAuth2 flow through the app). JWTs contain the user ID (e.g., `3469901296`) and are RSA-signed.

---

## Service Architecture

Bambu Lab's cloud API is a microservice architecture with **14 distinct services**:

| Service | Prefix | Purpose |
|---------|--------|---------|
| [IoT Service](#iot-service) | `/iot-service/` | Printer management, binding, certificates, slicer |
| [User Service](#user-service) | `/user-service/` | Messages, notifications, tasks, device tokens |
| [Design Service](#design-service) | `/design-service/` | 3D model CRUD, favorites, slicing, downloads |
| [Design User Service](#design-user-service) | `/design-user-service/` | Profile, preferences, follows, permissions |
| [Design Recommend Service](#design-recommend-service) | `/design-recommend-service/` | Personalized recommendations |
| [Comment Service](#comment-service) | `/comment-service/` | Comments, ratings, message sessions |
| [Search Service](#search-service) | `/search-service/` | Search, navigation, trending, related designs |
| [Operation Service](#operation-service) | `/operation-service/` | App configuration, homepage content |
| [Aftersale Service](#aftersale-service) | `/aftersale-service/` | Support tickets, unread counts |
| [Point Service](#point-service) | `/point-service/` | Points/rewards, design boosting |
| [Report Service](#report-service) | `/report-service/` | Content reporting/moderation |
| [Task Service](#task-service) | `/task-service/` | Onboarding tasks, achievements |
| [Analysis Service](#analysis-service) | `/analysis-st/` | Analytics tags, user tracking |
| [Event Service](#event-service) | `event.bblmw.com` | Telemetry, analytics events |

---

## IoT Service

Printer management, device binding, certificate exchange, and slicer settings.

### `GET /iot-service/api/user/bind`

List all printers bound to the authenticated user's account.

**Response:** Array of printer objects with serial numbers, model info, online status.

```bash
curl -s https://api.bambulab.com/v1/iot-service/api/user/bind \
  -H "Authorization: Bearer $TOKEN"
```

### `POST /iot-service/api/user/ttcode`

Generate a TUTK (ThroughTek) connection code for P2P camera/LAN access.

```bash
curl -s -X POST https://api.bambulab.com/v1/iot-service/api/user/ttcode \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

### `GET /iot-service/api/user/profile/{userId}`

Get a user's printer profile. The `model_id` parameter identifies a specific printer.

| Parameter | Type | Description |
|-----------|------|-------------|
| `userId` | path | Numeric user ID (e.g., `614790751`) |
| `model_id` | query | Printer model identifier (e.g., `USf86740b8413939`) |

```bash
curl -s "https://api.bambulab.com/v1/iot-service/api/user/profile/614790751?model_id=USf86740b8413939" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /iot-service/api/user/task/{taskId}`

Get details of a specific print task by ID.

```bash
curl -s https://api.bambulab.com/v1/iot-service/api/user/task/788462557 \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /iot-service/api/user/applications/{appToken}/cert`

Exchange an application token for an X.509 device certificate. Used for MQTT authentication.

| Parameter | Type | Description |
|-----------|------|-------------|
| `appToken` | path | Base64url-encoded application token |
| `aes256` | query | AES-256 encrypted payload for cert request |

The app token and AES payload are generated client-side. The response contains the certificate and private key needed for MQTT TLS connections to printers.

```bash
curl -s "https://api.bambulab.com/v1/iot-service/api/user/applications/{appToken}/cert?aes256={encrypted}" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /iot-service/api/slicer/setting`

Get slicer configuration settings.

| Parameter | Type | Description |
|-----------|------|-------------|
| `version` | query | Slicer version (e.g., `1.0.0.1`) |
| `public` | query | Boolean — public vs private settings |

```bash
curl -s "https://api.bambulab.com/v1/iot-service/api/slicer/setting?version=1.0.0.1&public=false" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /iot-service/api/slicer/resource`

Download slicer resources (print profiles, info bundles).

| Parameter | Type | Example |
|-----------|------|--------|
| `slicer/info/bbl` | query | `01.00.00.04` |
| `slicer/settings/bbl` | query | `02.05.00.02` |

```bash
curl -s "https://api.bambulab.com/v1/iot-service/api/slicer/resource?slicer/info/bbl=01.00.00.04" \
  -H "Authorization: Bearer $TOKEN"
```

---

## User Service

User account management, messaging, notifications, print tasks.

### `GET /user-service/my/messages`

Get paginated messages by type.

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | query | Message type: `1`=system, `2`=comments, `3`=likes, `4`=follows, `5`=prints |
| `offset` | query | Pagination offset |
| `limit` | query | Page size (default 20) |

```bash
# Get comment notifications
curl -s "https://api.bambulab.com/v1/user-service/my/messages?type=2&offset=0&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /user-service/my/message/count`

Get unread message count across all categories.

### `GET /user-service/my/message/latest`

Get the most recent message.

### `POST /user-service/my/message/read`

Mark messages as read.

### `GET /user-service/my/message/device/taskstatus`

Get device task status for notification badges.

### `POST /user-service/my/message/device/tasks/read`

Mark device task notifications as read.

### `GET /user-service/my/task/{taskId}`

Get a specific print task by ID.

```bash
curl -s https://api.bambulab.com/v1/user-service/my/task/788462557 \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /user-service/my/task/printedplates`

Get printed plate information for a design instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `instanceId` | query | Design instance ID |

### `GET /user-service/my/model/profile`

Get model/printer profile linked to user.

| Parameter | Type | Description |
|-----------|------|-------------|
| `profileId` | query | Profile ID (e.g., `635995371`) |
| `modelId` | query | Printer model ID (e.g., `US932767835d32ea`) |

### `POST /user-service/user/devicetoken`

Register device push notification token (FCM/APNs).

### `GET /user-service/latest/app`

Check for app updates. Returns latest version info.

---

## Design Service

3D model management — designs (models), instances (print profiles), favorites, downloads.

### `GET /design-service/design/{designId}`

Get full design details including title, creator, instances, tags, images.

| Parameter | Type | Description |
|-----------|------|-------------|
| `designId` | path | Numeric design ID |
| `trafficSource` | query | `browse`, `recommend`, `search` — for analytics |
| `visitHistory` | query | `true` to log visit |

```bash
curl -s "https://api.bambulab.com/v1/design-service/design/2416782?trafficSource=browse&visitHistory=true" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /design-service/design/{designId}/remixed`

Get designs that are remixes of a given design.

### `POST /design-service/design/{designId}/like`

Like/unlike a design (toggle).

### `GET /design-service/instance/{instanceId}/f3mf`

Download a 3MF file for a design instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `instanceId` | path | Instance ID |
| `type` | query | `preview` or `download` |

```bash
# Preview (metadata only)
curl -s "https://api.bambulab.com/v1/design-service/instance/2650240/f3mf?type=preview" \
  -H "Authorization: Bearer $TOKEN"

# Download (full 3MF file)
curl -sOJ "https://api.bambulab.com/v1/design-service/instance/2650240/f3mf?type=download" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /design-service/favorites/designs/{userId}`

Get a user's favorited designs.

| Parameter | Type | Description |
|-----------|------|-------------|
| `userId` | path | Numeric user ID |
| `offset` | query | Pagination offset |
| `limit` | query | Page size |

### `GET /design-service/my/design/favoriteslist`

Check if specific designs are in the current user's favorites.

| Parameter | Type | Description |
|-----------|------|-------------|
| `designId` | query | Design ID to check |

### `GET /design-service/my/design/like`

Get designs the current user has liked.

### `GET /design-service/my/favorites/listlite`

Get a lightweight list of all favorited design IDs.

### `GET /design-service/draft/sliceerror`

Get draft designs with slicing errors.

---

## Design User Service

User profile, preferences, social features, and permissions on MakerWorld.

### `GET /design-user-service/my/profile`

Get the current user's MakerWorld profile.

| Parameter | Type | Description |
|-----------|------|-------------|
| `immediacy` | query | `true` for non-cached response |

```bash
curl -s "https://api.bambulab.com/v1/design-user-service/my/profile?immediacy=true" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /design-user-service/my/preference`

Get user preferences (notification settings, content filters, etc.).

### `GET /design-user-service/my/follow/mutual`

Get mutual follows (users who follow you and you follow back).

### `GET /design-user-service/my/permission`

Check user permissions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `permType` | query | Permission type: `0`=general, `6`=upload |

---

## Design Recommend Service

### `GET /design-recommend-service/my/for-you`

Personalized design recommendations ("For You" feed).

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | query | Number of results (default 20) |
| `offset` | query | Pagination offset |
| `seed` | query | Randomization seed (0 for fresh) |
| `acceptTypes` | query | Comma-separated type IDs: `0`=model, `2`=remix, `5`=collection, `6`=tutorial, `3`=article |

```bash
curl -s "https://api.bambulab.com/v1/design-recommend-service/my/for-you?limit=20&offset=0&seed=0&acceptTypes=0,2,5,6,3" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Comment Service

Comments, ratings, and messaging for designs.

### `GET /comment-service/commentandrating`

Get comments and ratings for a design.

| Parameter | Type | Description |
|-----------|------|-------------|
| `designId` | query | Design ID |
| `offset` | query | Pagination offset |
| `limit` | query | Page size (default 20) |
| `type` | query | `0`=all, other values filter |
| `sort` | query | `0`=newest first |

```bash
curl -s "https://api.bambulab.com/v1/comment-service/commentandrating?designId=2416782&offset=0&limit=20&type=0&sort=0" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /comment-service/comment/{commentId}/detail`

Get a single comment with full details.

### `GET /comment-service/comment/{commentId}/reply`

Get replies to a comment.

| Parameter | Type | Description |
|-----------|------|-------------|
| `commentId` | path | Parent comment ID |
| `limit` | query | Max replies (default 10) |
| `after` | query | Cursor — reply ID to paginate after |
| `msgCommentReplyId` | query | Specific reply to load context around |

### `POST /comment-service/comment/{commentId}/like`

Like a comment (toggle).

### `POST /comment-service/comment/{commentId}/reply`

Post a reply to a comment.

### `GET /comment-service/rating/inst/{instanceId}`

Get rating data for a specific design instance.

### `GET /comment-service/messagesession/list`

Get message sessions (direct messages inbox).

| Parameter | Type | Description |
|-----------|------|-------------|
| `userSelect` | query | `all` or specific filter |
| `typeSelect` | query | `all` or specific filter |
| `projectScope` | query | `0`=general, `2`=MakerWorld |
| `offset` | query | Pagination offset |
| `limit` | query | Page size |

---

## Search Service

Design search, navigation categories, trending, and related content.

### `GET /search-service/homepage/nav`

Get homepage navigation structure (categories, featured sections).

### `GET /search-service/recommand/youlike`

Get "recommended for you" designs (note: API typo is `recommand`).

### `GET /search-service/select/design/nav`

Browse designs by navigation category.

| Parameter | Type | Description |
|-----------|------|-------------|
| `navKey` | query | Category key: `Trending`, `category_400` (Toys & Games), `category_800` (Home), etc. |
| `offset` | query | Pagination offset |
| `limit` | query | Page size (default 20) |

```bash
# Trending designs
curl -s "https://api.bambulab.com/v1/search-service/select/design/nav?navKey=Trending&offset=0&limit=20" \
  -H "Authorization: Bearer $TOKEN"

# Toys & Games category
curl -s "https://api.bambulab.com/v1/search-service/select/design/nav?navKey=category_400&offset=0&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /search-service/design/{designId}/relate`

Get designs related to a specific design.

| Parameter | Type | Description |
|-----------|------|-------------|
| `designId` | path | Design ID |
| `offset` | query | Pagination offset |
| `limit` | query | Page size |
| `scene` | query | Relation scene (`1`=similar) |

---

## Operation Service

App-level configuration and dynamic content.

### `GET /operation-service/apphomepage`

Get app homepage configuration (banners, featured content, section ordering).

### `GET /operation-service/configuration`

Get app-wide configuration (feature flags, URLs, settings).

---

## Aftersale Service

### `GET /aftersale-service/trouble/totalunreadcount`

Get count of unread support trouble tickets.

### `GET /aftersale-service/makerworld/totalunreadcount`

Get count of unread MakerWorld-related support items.

---

## Point Service

### `GET /point-service/boost/boostdesign`

Get boost status for a design (points-based promotion).

| Parameter | Type | Description |
|-----------|------|-------------|
| `designId` | query | Design ID |

---

## Report Service

### `GET /report-service/report/classification`

Get report/moderation classification options.

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | query | Report source context: `message`, `design`, etc. |

---

## Task Service

### `GET /task-service/user/taskv2/multi`

Get multiple onboarding/achievement task statuses.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskNames` | query | Comma-separated task names: `app_newbie_task_v2`, `app_newbie_task_v3` |

---

## Analysis Service

### `GET /analysis-st/tag/`

Get user analytics/tracking tags.

| Parameter | Type | Description |
|-----------|------|-------------|
| `UID` | query | User analytics UID (UUID format) |

---

## Event Service

Telemetry and analytics events — sent to `event.bblmw.com` (separate from main API).

### `POST https://event.bblmw.com/app2/home`

Log home screen analytics events.

### `POST https://event.bblmw.com/app2/makerworld`

Log MakerWorld browsing analytics events.

---

## IP Geolocation

The app calls an external IP geolocation service on startup:

```
GET http://ip-api.com/json/?fields=status,message,continent,continentCode,country,countryCode,
    region,regionName,city,district,zip,lat,lon,timezone,offset,currency,isp,org,as,asname,
    reverse,mobile,proxy,hosting,query
```

This is used for regional content serving and analytics.

---

## Common Patterns

### Pagination

All list endpoints use `offset` + `limit` pagination:

```
?offset=0&limit=20    # First page
?offset=20&limit=20   # Second page
```

### Resource IDs

| Resource | Format | Example |
|----------|--------|---------|
| User ID | Numeric (10 digits) | `3469901296` |
| Design ID | Numeric (7 digits) | `2416782` |
| Instance ID | Numeric (7 digits) | `2650240` |
| Comment ID | Numeric (7 digits) | `4177733` |
| Task ID | Numeric (9 digits) | `788462557` |
| Printer serial | `{region}{hex}` | `USf86740b8413939` |
| Profile ID | Numeric (9 digits) | `635995371` |
| Analytics UID | UUID v1 | `65c31ea0-cd74-11ed-b18f-39cf197fa3d4` |

### Error Responses

All services return errors in a consistent format:

```json
{
  "code": 400,
  "message": "error description",
  "error": "BadRequest"
}
```

### Navigation Category Keys

| navKey | Category |
|--------|----------|
| `Trending` | Trending designs |
| `category_400` | Toys & Games |
| `category_800` | Home & Living |

---

## Discovery Method

This API reference was reverse-engineered using:

1. **Static analysis** — APK decompilation (jadx) + URL pattern extraction
2. **Dynamic capture** — Flutter Dio interceptor logs via `adb logcat -s flutter:*`
3. **Token extraction** — Heap dump scan for JWT tokens
4. **Tool**: [apkre](https://github.com/schwarztim/bambu-mcp) automated API discovery platform

The Bambu Handy app is a Flutter/Dart application using the Dio HTTP client, which conveniently logs all HTTP requests in debug builds via logcat.
