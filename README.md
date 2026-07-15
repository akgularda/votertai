# VoterTAI

VoterTAI is the RadioTEDU next-song voting system. It contains the public voting website, the web-server API integration, and the Windows radio agent that continuously streams the winning songs to Icecast.

## Components

- `voting-web/` — responsive React/TypeScript voting website, including the secure mobile WebView bridge.
- `backend/` — Express/PostgreSQL API, Socket.IO voting updates, agent WebSocket endpoint, and `/vote/` static hosting.
- `tools/local-voting-agent/` — Windows music-folder scanner, voting-round automation, Icecast source, backend WSS client, crash supervisor, and startup installers.

## Architecture

```text
Windows Voting PC -- outbound WSS --> Web server
Windows Voting PC -- Icecast source --> /ai
Browser / mobile WebView -- HTTPS + Socket.IO --> Web server
Listeners -- HTTPS audio --> /ai
```

The Voting PC never exposes its filesystem or an inbound public port. Agent secrets, Icecast credentials, local paths, runtime logs, and `.env` files are intentionally excluded from Git.

## Voting website

```powershell
cd voting-web
npm ci
npm test
npm run build
```

Production routes:

- Website: `https://radiotedu.com/vote/`
- WebView: `https://radiotedu.com/vote/?embed=1`
- API: `https://radiotedu.com/jukebox/api/v1`
- Socket.IO path: `/jukebox/socket.io`

See `voting-web/README.md` for the WebView authentication bridge and deployment contract.

## Windows voting agent

```powershell
cd tools/local-voting-agent
npm ci
Copy-Item .env.example .env
npm test
npm run build
```

Configure `.env` with the local music folder, dedicated `/ai` Icecast source credentials, and the dedicated radio-agent secret. Do not commit that file.

Install automatic startup and the crash supervisor:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-voting-task.ps1
```

The music library is rescanned periodically. Icecast and backend WebSocket connections reconnect indefinitely with bounded exponential backoff.

## Verification

Run package-local checks before deployment:

```powershell
cd voting-web
npm ci
npm test
npm run build

cd ..\tools\local-voting-agent
npm ci
npm test
npm run build

cd ..\..\backend
npm ci
npm test
npm run build
```

Deployment secrets must be provided by the server's protected environment or secret store. Production must never use example values.
