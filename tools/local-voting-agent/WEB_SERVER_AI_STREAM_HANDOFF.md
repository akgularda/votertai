# `/ai` continuous audio handoff

The Voting PC is the playout/source computer. The website server owns the
Icecast/TinyIce origin and the public TLS listener.

## Current verified Voting PC source

- LAN listener: `http://10.10.1.125:4320/ai`
- Format: MP3, 48 kHz stereo, 128 kbps
- `HEAD /ai`: HTTP 200 with `Content-Type: audio/mpeg`
- `GET /ai`: an unbounded chunked audio response
- The encoder remains alive across tracks. A PCM silence guard keeps the byte
  stream continuous while a decoder starts or recovers.
- A supervised relay continuously tries to publish that stream to
  `http://10.98.98.75:11154/ai`. It uses the source credential stored only on
  the Voting PC and retries forever with bounded backoff.

No source password is required on the website/application host. Do not copy it
from the Voting PC or add it to a prompt, repository, log, or proxy config.

## Required server repair

Discover the actual Icecast/TinyIce service and service manager on
`10.98.98.75`; do not assume a container or unit name. Repair the existing
origin in place so all of the following are true:

1. A real Icecast-compatible source listener is bound on private TCP port
   `11154` and accepts the configured source identity for mount `/ai`.
2. A listener GET to private `/ai` remains open and returns `audio/mpeg` while
   the Voting PC relay is connected. It must not reset the TCP connection after
   the first source packets.
3. `https://stream.radiotedu.com/ai` proxies only to the private listener mount;
   it must never be used as a source-ingest endpoint.
4. Nginx uses HTTP/1.1 with response buffering disabled and long read timeouts
   for the infinite audio response. Keep CORS `*`, `Cache-Control: no-store`,
   and `X-Content-Type-Options: nosniff` on the public mount.
5. Configure an always-running server-local fallback source/mount and make it
   the Icecast fallback for `/ai`. The fallback must contain decodable audio,
   remain available when the Voting PC or network is down, and automatically
   yield to `/ai` when the primary source reconnects.
6. Restart only the dedicated stream proxy/origin/fallback services. Preserve
   the website, WordPress, voting API, database, unrelated mounts, TLS, and DNS.

A typical Nginx listener location (adapt upstream address to the actual local
Icecast listener) is:

```nginx
location = /ai {
    proxy_pass http://127.0.0.1:11154/ai;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```

## Acceptance tests

Do not report success from process state or HTTP headers alone. Retain redacted
evidence for each check:

1. Decode `https://stream.radiotedu.com/ai` with FFmpeg for at least 30 seconds.
2. Confirm the Voting PC relay connects without a TCP reset and the public
   audio is not the fallback.
3. Stop only the `/ai` primary source and keep the same public decoder running;
   prove fallback audio continues without an HTTP disconnect or decode error.
4. Restore the primary source and prove the public stream returns to it.
5. Restart the dedicated origin/proxy/fallback services and repeat the public
   30-second decode.

The current failure signature is authoritative: private port `11154` accepts a
TCP connection and then resets both listener GETs and MP3 source uploads;
public `https://stream.radiotedu.com/ai` consequently returns HTTP 404. Fixing
only Nginx cannot satisfy these tests while the private origin still resets.
