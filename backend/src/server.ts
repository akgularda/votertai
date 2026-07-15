import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { initIO } from './socket';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import authRoutes from './routes/auth';
import podcastRoutes from './routes/podcasts';
import podcastFeedRoutes from './routes/podcastFeeds';
import radioRoutes from './routes/radio';
import jukeboxRoutes from './routes/jukebox';
import radioProfilesRoutes from './routes/radioProfiles';
import usersRoutes from './routes/users';
import spotifyRoutes from './routes/spotify';
import gamificationRoutes from './routes/gamification';
import studyRoutes from './routes/study';
import profileRoutes from './routes/profile';
import notificationRoutes from './routes/notifications';
import nextSongVotingRoutes from './routes/nextSongVoting';
import { authMiddleware } from './middleware/auth';
import { setupSocketHandlers } from './sockets';
import { registerUtilityRoutes } from './utilityRoutes';
import { startRadioHistoryWatcher } from './services/radioHistory';
import { syncPodcastFeed } from './services/podcastFeeds';
import { ensureDefaultPodcastFeeds, getDefaultPodcastFeeds } from './services/defaultPodcastFeeds';
import { db } from './db';
import { resolveCorsOrigins } from './config/cors';
import { registerControllerWebRoutes } from './controllerWebRoutes';
import { registerVotingPublicAssetRoutes } from './votingPublicAssets';
import { registerVotingWebRoutes } from './votingWebRoutes';
import {
    attachRadioAgentTunnel,
    RadioAgentRequestError,
} from './services/radioAgentTunnel';
import {
    nextSongVotingService,
    setRadioAgentStatusProvider,
    VotingServiceError,
} from './services/nextSongVotingService';

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

// Fail fast on missing JWT secrets in non-test environments so the server never
// boots with insecure defaults. Tests are allowed deterministic defaults.
if (!IS_TEST_ENV) {
    const missingSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET'].filter(
        (name) => !process.env[name] || !process.env[name]!.trim()
    );
    if (missingSecrets.length > 0) {
        throw new Error(
            `Missing required environment variable(s): ${missingSecrets.join(', ')}. ` +
            'Set them before starting the server.'
        );
    }
}

const app = express();
const corsOrigin = resolveCorsOrigins(process.env.CORS_ORIGINS, {
    isProduction: process.env.NODE_ENV === 'production' && !IS_TEST_ENV,
});

function normalizePublicBasePath(value?: string) {
    const trimmed = (value || '').trim();
    if (!trimmed || trimmed === '/') {
        return '';
    }

    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeadingSlash.endsWith('/')
        ? withLeadingSlash.slice(0, -1)
        : withLeadingSlash;
}

const publicBasePath = normalizePublicBasePath(process.env.PUBLIC_BASE_PATH);
const httpServer = createServer(app);
const io = initIO(httpServer, { corsOrigin });

function safeRequestPath(request: express.Request) {
    try {
        return new URL(request.originalUrl || request.url, 'http://localhost').pathname;
    } catch {
        return '/invalid-path';
    }
}

const radioAgentTunnel = process.env.RADIO_AGENT_TRANSPORT?.trim().toLowerCase() === 'websocket'
    ? attachRadioAgentTunnel(httpServer, {
        requestHandler: async ({agentId, method, payload}) => {
            try {
                return await nextSongVotingService.handleAgentRequest(agentId, method, payload);
            } catch (error) {
                if (error instanceof VotingServiceError) {
                    if (error.httpStatus === 400) throw new RadioAgentRequestError('invalid_payload');
                    if (error.httpStatus === 403 || error.httpStatus === 401) {
                        throw new RadioAgentRequestError('not_authorized');
                    }
                    if (error.httpStatus === 404) throw new RadioAgentRequestError('not_found');
                    if (error.httpStatus === 409) throw new RadioAgentRequestError('conflict');
                    throw new RadioAgentRequestError('service_unavailable');
                }
                throw new RadioAgentRequestError('internal_error');
            }
        },
    })
    : null;

if (radioAgentTunnel) {
    const primaryAgentId = (process.env.RADIO_AGENT_ALLOWED_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)[0] ?? null;
    setRadioAgentStatusProvider(() => {
        if (!primaryAgentId) return {agentId: null, connected: false, lastSeen: null};
        const status = radioAgentTunnel.getAgentStatus(primaryAgentId);
        return {agentId: status.agentId, connected: status.connected, lastSeen: status.lastSeen};
    });
}

function mountWithOptionalPublicBase(routePath: string, handler: express.RequestHandler | express.Router) {
    app.use(routePath, handler);
    if (publicBasePath) {
        app.use(`${publicBasePath}${routePath}`, handler);
    }
}

function registerGetWithOptionalPublicBase(routePath: string, handler: express.RequestHandler) {
    app.get(routePath, handler);
    if (publicBasePath) {
        app.get(`${publicBasePath}${routePath}`, handler);
    }
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Never log query values: playback tickets, signatures and tokens may be
// transported by legacy callers in a query string.
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${safeRequestPath(req)}`);
    next();
});
app.use(rateLimit({ windowMs: 60000, max: 500 }));
registerUtilityRoutes(app);

registerVotingPublicAssetRoutes(app, {
    fallbackLogoPath: path.join(__dirname, '../../jukebox-web-controller/public/radiotedu-logo.png'),
    publicBasePath,
});

// Static: Kiosk Web App
mountWithOptionalPublicBase('/kiosk', express.static(path.join(__dirname, '../../kiosk-web'), {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));
mountWithOptionalPublicBase('/uploads', express.static(path.join(__dirname, '../uploads')));

// Static: Jukebox Web Controller (built SPA). Assets stay under /controller.
// The exact /jukebox page alias is for temporary QR links and does not capture
// /jukebox/* API routes.
const controllerDistPath = path.join(__dirname, '../../jukebox-web-controller/dist');
registerControllerWebRoutes(app, {
    controllerDistPath,
    pageAliases: ['/jukebox'],
    publicBasePath,
});

// Public next-song voting site. It is the shared responsive surface used by
// normal browsers and the mobile application's WebView.
const votingWebDistPath = path.join(__dirname, '../../voting-web/dist');
registerVotingWebRoutes(app, {
    distPath: votingWebDistPath,
    publicBasePath,
});

// Static: Focus / Study web room. This intentionally mounts only /focus and
// does not capture the existing /jukebox controller or API paths.
const focusWebPath = path.join(__dirname, '../../prototypes/library-study');
mountWithOptionalPublicBase('/focus', express.static(focusWebPath, {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// Static: Social web room. Kept separate from /focus and /jukebox so each
// product surface can move independently.
const socialWebPath = path.join(__dirname, '../../prototypes/library-study');
mountWithOptionalPublicBase('/social', express.static(socialWebPath, {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// Routes
mountWithOptionalPublicBase('/api/v1/auth', authRoutes);
mountWithOptionalPublicBase('/api/v1/podcasts', podcastRoutes);
mountWithOptionalPublicBase('/api/v1/podcast-feeds', podcastFeedRoutes);
mountWithOptionalPublicBase('/api/v1/radio', radioRoutes);
mountWithOptionalPublicBase('/api/v1/radio-profiles', radioProfilesRoutes);

// Jukebox: Kiosk endpoints (no auth required)
app.use('/jukebox', jukeboxRoutes);

// Jukebox: User endpoints (auth handled per-route in jukeboxRoutes)
mountWithOptionalPublicBase('/api/v1/jukebox', jukeboxRoutes);
mountWithOptionalPublicBase('/api/v1/users', usersRoutes);
mountWithOptionalPublicBase('/api/v1/spotify', spotifyRoutes);
mountWithOptionalPublicBase('/api/v1/gamification', gamificationRoutes);
mountWithOptionalPublicBase('/api/v1/study', studyRoutes);
mountWithOptionalPublicBase('/api/v1/profile', profileRoutes);
mountWithOptionalPublicBase('/api/v1/notifications', notificationRoutes);
mountWithOptionalPublicBase('/api/v1/next-song-voting', nextSongVotingRoutes);

// Health check
registerGetWithOptionalPublicBase('/health', (req, res) => res.json({ status: 'ok' }));

// Socket.IO
setupSocketHandlers(io);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
        ? err.status
        : 500;
    console.error(JSON.stringify({
        component: 'http',
        event: 'unhandled_error',
        method: req.method,
        path: safeRequestPath(req),
        status,
        error: typeof err?.name === 'string' ? err.name : 'InternalServerError',
    }));
    return res.status(status).json({
        success: false,
        error: status >= 500 ? 'InternalServerError' : 'RequestError',
        message: status >= 500 ? 'An unexpected error occurred' : 'The request could not be completed'
    });
});

// Background tasks (never started under tests to keep the suite deterministic
// and avoid open timers / live network or DB calls).
function startBackgroundTasks() {
    // Radio now-playing history watcher + periodic cleanup.
    startRadioHistoryWatcher();

    // Periodic podcast RSS sync.
    const podcastSyncIntervalHours = Number(process.env.PODCAST_SYNC_INTERVAL_HOURS) || 6;
    const podcastSyncIntervalMs = podcastSyncIntervalHours * 60 * 60 * 1000;

    async function runPodcastSync() {
        try {
            await ensureDefaultPodcastFeeds(db, getDefaultPodcastFeeds(process.env.DEFAULT_PODCAST_FEEDS));
            const result = await db.query(
                'SELECT id, feed_url, title FROM podcast_feeds WHERE is_active = true'
            );
            for (const feed of result.rows) {
                try {
                    await syncPodcastFeed(db, {
                        id: feed.id,
                        feedUrl: feed.feed_url,
                        title: feed.title,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'unknown error';
                    console.error(`[podcastSync] Failed to sync feed "${feed.id}":`, message);
                }
            }
        } catch (error) {
            console.error('[podcastSync] Failed to load podcast feeds for sync:', error);
        }
    }

    // Initial sync shortly after startup, then on a fixed interval.
    const initialSyncTimer = setTimeout(() => {
        void runPodcastSync();
    }, 30_000);
    if (typeof initialSyncTimer.unref === 'function') {
        initialSyncTimer.unref();
    }

    const podcastSyncTimer = setInterval(() => {
        void runPodcastSync();
    }, podcastSyncIntervalMs);
    if (typeof podcastSyncTimer.unref === 'function') {
        podcastSyncTimer.unref();
    }
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

if (!IS_TEST_ENV) {
    startBackgroundTasks();
}

// io is now accessed via getIO() in other modules
