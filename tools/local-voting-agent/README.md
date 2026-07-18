# RadioTEDU Local Voting Radio Agent

This Windows-side agent turns a local music folder into the listener-controlled RadioTEDU Voting channel. It owns the Icecast `/ai` mount, keeps music playing when no voting round is active, and uses the winning candidate as the next track. The source uses the same AAC-LC/ADTS profile as RadioTEDU Broadcast Wall and publishes through the production HTTP source ingress.

The Voting agent is isolated from Juke Local and BroadcastAI. It has its own process, localhost API, WebSocket identity, secret, logs, and startup supervisor.

## Playback Lifecycle

1. A random enabled track starts when the queue is empty.
2. As soon as the current track starts, the agent selects three eligible candidates and publishes a round.
3. The current track continues without being cut.
4. At 10 seconds before the end, voting locks and the backend resolves the winner from registered-user ballots.
5. The winner is queued once and plays after the current track.
6. With no votes, the agent selects a fallback candidate. Ties are resolved among the tied leaders.

The current track and a recent-track window are excluded from candidate selection. Disabled songs are never selected.

## Architecture

```text
Music PC (this agent) -- outbound WSS --> radiotedu.com backend
Music PC (FFmpeg HTTP source) -- Icecast source --> stream.radiotedu.com/ai
Mobile app            -- HTTPS/WSS --> radiotedu.com backend
Listeners             -- Icecast listener --> /ai
```

The backend never reads the Music PC filesystem. Candidate metadata and small validated cover assets travel through the dedicated outbound WebSocket. Local paths and source credentials are never sent.

## Requirements

- Windows 10/11
- Node.js 20.6 or newer
- npm
- FFmpeg and ffprobe
- An Icecast source account authorized for `/ai`

## Install

```powershell
npm install
Copy-Item .env.example .env
```

Configure `.env`, then verify:

```powershell
npm test
npm run build
npm run dashboard
```

The local dashboard and API listen only on `http://127.0.0.1:4317`.

## Core Configuration

```dotenv
MUSIC_LIBRARY_DIR=C:\Users\tedu\Downloads\song
MUSIC_LIBRARY_REFRESH_SECONDS=60
CANDIDATE_COUNT=3
VOTING_OPEN_BEFORE_END_SECONDS=86400
VOTING_LOCK_BEFORE_END_SECONDS=10
VOTING_RECENT_TRACK_LIMIT=8
VOTING_AGENT_PLAYBACK_MODE=live

ICECAST_STREAM_ENABLED=true
ICECAST_SOURCE_URL=http://stream.radiotedu.com/ai
ICECAST_SOURCE_USERNAME=<source-user>
ICECAST_SOURCE_PASSWORD=<source-password>

BACKEND_SYNC_ENABLED=true
RADIO_AGENT_TRANSPORT=websocket
RADIO_AGENT_CONNECT_URL=wss://radiotedu.com/jukebox/api/v1/next-song-voting/agent/connect
RADIO_AGENT_ID=school-radio-pc
RADIO_AGENT_REQUEST_SECRET=<dedicated-voting-secret>
```

Do not reuse Juke Local's agent ID or secret. Do not commit `.env` or log its contents.

## Music And Cover Art

Supported audio formats include AAC, FLAC, M4A, MP3, OGG, WAV, and WebM. The scanner reads metadata with ffprobe and falls back to `Artist - Song` filenames.

Cover discovery checks:

- a matching image beside the audio file
- `cover`, `folder`, `front`, or `album` images
- embedded artwork or a video frame when the source contains one

Embedded-art extraction is disabled by default so a malformed cover stream can
never delay radio startup. Set `EXTRACT_EMBEDDED_ALBUM_ART=true` only when that
extra boot-time work is explicitly desired; nearby image files are always used.

Cover assets sent to the backend are limited to JPEG, PNG, or WebP and 1.5 MB. A RadioTEDU fallback image should be used when no real cover exists.

## Dedicated WebSocket Contract

The agent connects outbound using protocol `radiotedu-radio-agent/v1` and these headers:

- `x-radio-agent-id`
- `x-radio-agent-timestamp`
- `x-radio-agent-signature`

The signature is base64url HMAC-SHA256 of `<agent-id>:<unix-seconds>`. Supported request methods are `round.publish`, `round.active`, and `round.resolve`. The client reconnects every five seconds and answers backend ping messages.

## Windows Startup

For production, install the dedicated automatic Windows service from an
**elevated PowerShell** window:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-voting-service.ps1
```

The service starts as Windows boots, before user sign-in. It supervises the
existing Node watchdog rather than replacing it, checks both the loopback API
and real audio bytes, and uses Windows Service Recovery to restart after
unexpected service failures. The Node watchdog continues to reconnect the
backend WSS and `/ai` source indefinitely with bounded backoff. Process locks
make the service, watchdog, and any accidental manual launch safe against
duplicate ownership.

If administrator access is temporarily unavailable, install the per-user
sign-in fallback:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-voting-startup.ps1
```

The music folder is rescanned every 60 seconds without restarting playback, so newly added or removed tracks automatically reach future voting rounds. The supervisor restarts the agent after crashes or loss of port 4317. The launcher starts it again after Windows sign-in. Icecast and backend WebSocket connections retry indefinitely with bounded backoff. The production `/ai` source ingress is HTTP on port 80; port 11154 currently resets this source after the first packets and must not be used by Voting. Runtime logs are written to `runtime-logs/` and ignored by Git.

## Health Checks

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/health
Invoke-RestMethod http://127.0.0.1:4317/api/state
```

`/api/health` reports catalog size, playback state, backend connection state,
and the dedicated Icecast source state without exposing local paths or secrets.

The hardened supervisor also reads real audio bytes from the loopback `/ai`
stream every cycle and from the public stream periodically. It replaces the
agent only after three consecutive local failures, logs state transitions
instead of repeating the same error, and keeps retrying indefinitely. An
exclusive process lock prevents a duplicate launch from touching the Icecast
mount before the control port is bound.

## Start or Recover a Production Voting Round

The production configuration uses a 24-hour open window, so every normal track
gets a three-candidate round as soon as it starts instead of leaving the site on
"waiting for a new round". To open one immediately and verify that it reached
the production website, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-production-voting-round.ps1
```

The command is idempotent: if production already has an open round, it reports
that round instead of creating another one. It waits for both the outbound
backend connection and Icecast playback, starts a round through the loopback
agent API, and then verifies the same round through the public RadioTEDU API.
It does not read or modify WordPress, personal accounts, or unrelated radio
mounts.

If the dedicated Voting process is unhealthy, restart only that process and
then perform the same verification:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-production-voting-round.ps1 -RestartAgent
```

Successful output contains `result: started`, `result: already_running`, or
`result: recovered_existing`, an open `roundId`, three candidates, and the
public vote-page URL. The exact public checks are:

```powershell
Invoke-RestMethod https://radiotedu.com/jukebox/api/v1/next-song-voting/status
Invoke-RestMethod https://radiotedu.com/jukebox/api/v1/next-song-voting/rounds/active
Invoke-WebRequest https://radiotedu.com/vote/
```

Verify the public audio path with FFmpeg:

```powershell
ffmpeg -hide_banner -loglevel error -t 5 -i https://stream.radiotedu.com/ai -f null NUL
```

## Safety Boundaries

- `/ai` belongs exclusively to Voting.
- Juke Local's AI mirror and autoplay must remain disabled.
- `/radio`, `/spark`, and other Icecast mounts are not modified.
- The local API binds to loopback and is not opened in Windows Firewall.
- The Music PC initiates WSS; no inbound port, router forwarding, SMB, or public IP is needed.
- The mobile app never connects directly to the Music PC.
