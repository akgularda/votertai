# RadioTEDU Voting Web

Responsive public voting surface shared by normal browsers and the RadioTEDU mobile WebView.

## Public routes

- Website: `https://radiotedu.com/vote/`
- Embedded website: `https://radiotedu.com/vote/?embed=1`
- API: `https://radiotedu.com/jukebox/api/v1`
- Socket.IO path: `/jukebox/socket.io`
- Voting stream: `https://stream.radiotedu.com/ai`

The backend serves the built `dist` folder at both `/vote/` and, when
`PUBLIC_BASE_PATH=/jukebox`, `/jukebox/vote/`. Production assets use relative
URLs so both mounts remain valid.

## Commands

```powershell
npm install
npm test
npm run build
npm run dev
```

For a visual-only local preview, open `http://127.0.0.1:4321/?demo=1`. Demo data
is compiled out of production behavior because it is gated by Vite's DEV flag.

## Mobile WebView auth bridge

Never put an access token in the URL. When the page announces readiness through
`window.ReactNativeWebView.postMessage`, inject the existing mobile session into
the page's in-memory bridge:

```js
window.__RADIOTEDU_SET_AUTH__({
  accessToken: '<mobile access token>',
  user: {display_name: 'Listener', is_guest: false}
});
true;
```

The page sends these messages back to React Native:

- `radiotedu.voting.ready`
- `radiotedu.voting.vote-recorded`

Only `https://radiotedu.com/vote/` navigation should be allowed inside the
WebView. External links should open through the operating system.

## Runtime overrides

Normal production deployment needs no frontend environment file. A server may
inject `window.__RADIOTEDU_VOTING_CONFIG__` before the application bundle when a
different origin is required:

```js
window.__RADIOTEDU_VOTING_CONFIG__ = {
  apiBaseUrl: 'https://radiotedu.com/jukebox/api/v1',
  socketOrigin: 'https://radiotedu.com',
  socketPath: '/jukebox/socket.io',
  streamUrl: 'https://stream.radiotedu.com/ai'
};
```
