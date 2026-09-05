# AquaFlow — Water Tanker Delivery Platform

A production-ready booking, dispatch and live-tracking platform for a water
tanker business. Customers order water and watch the tanker approach on a map;
dispatch assigns drivers and monitors the fleet; drivers run deliveries from
their phone.

---

## 1. Overview

Three applications share one Node.js/Express API and one PostgreSQL database:

| App | URL | Sign-in |
|---|---|---|
| Customer | `/` | Phone + OTP |
| Operations console | `/admin` | Phone + password |
| Driver | `/driver` | Phone + OTP |

Real-time delivery tracking runs over Socket.IO with per-order authorization,
so no customer ever receives another customer's data.

---

## 2. Features

**Customer**
- Phone + OTP sign-in (no passwords to remember or leak)
- Browse water loads with live, admin-controlled pricing
- Google Places search, map pin-drop, and one-tap current location
- Multiple saved addresses with a default
- Server-side serviceability check before checkout
- Razorpay online payment or cash on delivery
- Live tanker tracking: the full water station → your address route,
  with travelled/remaining legs, distance, ETA and a progress bar
- Order timeline, order history, cancellation while allowed
- In-app notifications on every status change
- AI support assistant grounded in real business data

**Admin**
- Dashboard: orders, revenue, fleet and driver counts, 7-day chart
- Orders table with search, status filter and pagination
- Assign driver + tanker, with capacity validation
- Live fleet map and active-delivery list
- Manage drivers, tankers, customers, water loads and pricing
- Payment ledger
- Service-area management (radius-based)
- Water-station management — delivery route origins
- Edit the chatbot's business knowledge base
- Read support conversation transcripts

**Driver**
- OTP sign-in, go online/offline
- Assigned jobs with customer contact and delivery notes
- Pickup station shown on each job; one-tap navigation to the station
  before pickup, then to the customer
- Accept / reject / start / arriving / delivered / failed
- Toggleable GPS sharing with `watchPosition`, throttled by time *and* movement
- Delivery history

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 18+ (tested on 24) |
| API | Express 4 |
| Database | **PostgreSQL 16** |
| ORM | Prisma 6 |
| Realtime | Socket.IO 4 |
| Auth | JWT (7-day) + phone OTP; bcrypt for admin passwords |
| Validation | Zod |
| Security | Helmet (CSP), CORS, express-rate-limit |
| Payments | Razorpay (server-side signature verification) |
| Maps | Google Maps JS + Places + Geocoding |
| AI | Pluggable — Anthropic, OpenAI-compatible, or offline rule-based |
| Frontend | Vanilla JS + custom CSS design system (no build step) |
| Tests | `node:test` |

---

## 4. Why PostgreSQL

The v1 app used Mongoose, so MongoDB was kept as the first option — but on
inspection it was not viable:

- MongoDB was **not installed and not running** (`mongod` absent, port 27017
  closed). The v1 `mongoose.connect()` logged its error and continued, so every
  API route failed at runtime. The app was not working.
- **No data existed to migrate.** MongoDB never accepted a connection, so nothing
  was ever written and nothing could be lost.
- The v1 schema was two models with no validation, indexes or relationships —
  there was no MongoDB investment worth preserving.
- The domain is strongly relational: orders reference customers, drivers,
  vehicles, addresses and products, and payments must be transactionally
  consistent with order status. `prisma.$transaction` gives that directly.
- PostgreSQL 16 runs in Docker here with zero host setup.

Prisma was chosen over Sequelize for its typed schema, generated client and
first-class migration workflow.

---

## 5. Folder structure

```
water-supply-/
├── client/                    static frontend (no build step)
│   ├── index.html             customer app
│   ├── admin.html             operations console
│   ├── driver.html            driver app
│   ├── css/app.css            design system
│   └── js/
│       ├── api.js             fetch wrapper, session, typed endpoints
│       ├── ui.js              toasts, sheets, skeletons, socket helper
│       ├── maps.js            Google Maps loader + graceful fallback
│       ├── customer.js  admin.js  driver.js
│
├── server/
│   ├── index.js               entry point, lifecycle, shutdown
│   ├── app.js                 express wiring, CSP, static, error handlers
│   ├── config/                env.js (validated), db.js (prisma + retry)
│   ├── middleware/            auth.js, validate.js, rateLimit.js, error.js
│   ├── routes/                auth, catalog, address, order, payment,
│   │                          driver, admin, chat, notification
│   ├── controllers/           auth, order, driver, admin
│   ├── services/              order, payment, otp, ai, notification,
│   │                          businessInfo
│   ├── sockets/index.js       authenticated rooms + GPS fan-out
│   └── utils/                 orderStateMachine, geo, logger, apiResponse
│
├── prisma/
│   ├── schema.prisma          15 models, enums, indexes
│   ├── migrations/
│   ├── seed.js                idempotent seed
│   └── clean.js               wipe demo/test activity
│
├── tests/                     53 tests
├── legacy/                    archived v1 (does not run)
├── docker-compose.yml         PostgreSQL on port 5434
├── .env.example
└── package.json
```

---

## 6. Installation

```bash
cd "water-supply-"
npm install
```

If npm reports blocked install scripts, allow Prisma's engine download:

```bash
npm approve-scripts prisma @prisma/client @prisma/engines
```

---

## 7. Environment variables

```bash
cp .env.example .env          # macOS / Linux
Copy-Item .env.example .env   # Windows PowerShell
```

Generate a JWT secret and paste it into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | PostgreSQL connection string |
| `JWT_SECRET` | **yes** | Session signing key, 32+ chars |
| `PORT` | no | Default `3000` |
| `NODE_ENV` | no | `production` force-disables demo mode |
| `DEMO_MODE` | no | `true` in dev: mock OTP + simulated payments |
| `ADMIN_SEED_PHONE` / `ADMIN_SEED_PASSWORD` | no | Seeded admin login |
| `DRIVER_SEED_PHONE` | no | Seeded driver login |
| `CORS_ORIGINS` | prod | Comma-separated allowed origins |
| `TRUST_PROXY` | no | `true` behind nginx / a PaaS |
| `GOOGLE_MAPS_API_KEY` | no | Browser key; maps degrade without it |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | prod | Live payments |
| `RAZORPAY_WEBHOOK_SECRET` | no | Webhook HMAC verification |
| `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` | no | Chatbot; falls back offline |
| `SMS_PROVIDER_KEY` | no | Real OTP delivery |
| `LOCATION_MIN_INTERVAL_MS` | no | Server GPS throttle, default 3000 |

`.env` is gitignored. No secret is hardcoded anywhere in the source.

---

## 8. Database setup

### Option A — Docker (recommended)

```bash
docker compose up -d
```

Starts `aquaflow-postgres` on host port **5434**. The port and container name
are namespaced to this project, so they do not collide with a local PostgreSQL
on 5432 or any other project's container.

`.env`:

```
DATABASE_URL=postgresql://aquaflow:aquaflow_dev_password@localhost:5434/water_app
```

Other commands:

```bash
docker compose logs -f db     # watch logs
docker compose down           # stop, keep data
docker compose down -v        # stop and DELETE all data
```

### Option B — existing local PostgreSQL

```bash
psql -U postgres -c "CREATE DATABASE water_app;"
psql -U postgres -c "CREATE USER aquaflow WITH PASSWORD 'your_password';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE water_app TO aquaflow;"
psql -U postgres -d water_app -c "GRANT ALL ON SCHEMA public TO aquaflow;"
```

`.env`:

```
DATABASE_URL=postgresql://aquaflow:your_password@localhost:5432/water_app
```

### Create the schema and seed

```bash
npx prisma migrate deploy    # apply migrations
npm run db:seed              # products, admin, driver, tanker, service area
```

The seed prints the admin credentials. If `ADMIN_SEED_PASSWORD` is blank it
generates one and prints it **once**.

Inspect data at any time:

```bash
npm run prisma:studio
```

### Clearing demo and test data

Development and testing leave customer accounts and orders behind, which then
show up in the driver and admin apps. To reset activity without losing your
configuration:

```bash
npm run db:clean            # preview what would be deleted
npm run db:clean -- --yes   # delete
```

Deletes customer accounts, orders, payments, addresses, notifications and
support conversations. **Keeps** products and pricing, admin accounts, drivers,
vehicles, service areas, water stations and the chatbot knowledge base. It
refuses to run when `NODE_ENV=production`.

---

## 9. Running the app

```bash
npm run dev     # nodemon, auto-restart
npm start       # plain node
```

Then open:

| | |
|---|---|
| Customer | http://localhost:3000/ |
| Admin | http://localhost:3000/admin |
| Driver | http://localhost:3000/driver |
| Health | http://localhost:3000/api/health |

There is no separate frontend server — Express serves `client/` directly, so
there is no build step and no bundler to configure.

### First run walkthrough

1. Open `/admin`, sign in with the seeded admin credentials.
2. Open `/` in another tab. Enter any 10-digit mobile number.
   In demo mode the OTP appears on screen and in the server log.
3. Add an address (use *Use my current location*, or drag the map pin).
4. Pick a load, confirm the order, complete the simulated payment.
5. In `/admin` → Orders → Manage, assign the seeded driver.
6. Open `/driver`, sign in as `9000000002`, go online, turn on location
   sharing, accept the job and walk it through to Delivered.
7. Watch the customer tab update live at every step.

---

## 10. Water stations and delivery routes

Tankers fill at **water stations**. When a customer places an order, the server
picks the nearest active station and stores it on the order. That station is the
origin of the route the customer tracks.

The tracking map draws the whole journey rather than only the remaining leg:

```
[station] ======== solid: distance covered ========> [tanker] - - - dashed - - -> [customer]
```

The customer also gets a progress strip showing what percentage of the way the
tanker has come, updated live over the socket. The driver sees the same leg on
each job, and the navigation button targets the station before pickup and the
customer afterwards.

Manage stations in **Admin → Water stations**: name, coordinates (or *use my
current location*), and an active toggle. Disabling a station stops it being
chosen for new orders without touching past ones; deleting one leaves historical
orders intact (the reference is nulled, not cascaded).

The seed creates three stations around the configured service-area centre. With
no stations configured the app still works — orders are simply created without a
route origin and the map shows only the tanker and the destination.

## 11. Google Maps setup

1. Google Cloud Console → enable **Maps JavaScript API**, **Places API**,
   **Geocoding API**.
2. Create an API key.
3. Restrict it: *Application restrictions* → HTTP referrers → add
   `http://localhost:3000/*` and your production domain. *API restrictions* →
   only the three APIs above.
4. Put it in `.env` as `GOOGLE_MAPS_API_KEY`.

The key is served to the browser from `/api/config`, never hardcoded in HTML,
so rotating it needs no code change. Without a key the app still works: address
entry falls back to current-location + manual coordinates, and tracking still
shows live distance and ETA.

> **Security note:** the v1 `index.html` contained a live Maps key in plaintext.
> It has been removed from the source tree. **Rotate that key** — see
> `legacy/README.md`.

---

## 12. Razorpay setup

1. Razorpay Dashboard → Settings → API Keys → generate.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env`.
3. Optional webhook: Settings → Webhooks → `https://yourdomain/api/payments/webhook`,
   events `payment.captured` and `payment.failed`, then set
   `RAZORPAY_WEBHOOK_SECRET`.

How payment is kept safe:

- The amount is read from the **Order row**, never from the request body.
- `POST /api/payments/create` returns only the publishable `key_id`. The secret
  never leaves the server.
- The signature is verified server-side with an HMAC timing-safe comparison.
- A `PAID` payment is never reprocessed — repeat verification returns
  `alreadyProcessed: true`.
- A second payment attempt on a paid order is refused with `409`.
- Payment success is what moves an order to `CONFIRMED`, via the `SYSTEM` actor.
  A customer can never perform that transition themselves.

Without keys, and only when `DEMO_MODE=true`, payments are simulated and every
record is flagged `isDemo: true` and labelled in the UI.

---

## 13. AI chatbot setup

```
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-opus-5
```

Also supports `AI_PROVIDER=openai` (with optional `AI_BASE_URL` for any
OpenAI-compatible gateway). Providers live in `server/services/ai.service.js`
as `{ name, isConfigured(), complete() }` objects — adding one is a single
object, nothing else in the app changes.

**Anti-hallucination.** The system prompt carries a business-facts block built
from the `Setting` table plus live product and service-area rows, and instructs
the model to answer only from it, replying *"I don't have that information.
Please contact support."* otherwise. Prices therefore cannot drift from what the
app actually charges. Edit the facts in **Admin → Chatbot & info**.

**Order awareness.** For a signed-in customer the prompt includes that
customer's own orders only — the query is `where: { customerId: user.id }`.
Anonymous visitors get no order context. Asking *"Where is my tanker?"* returns
that customer's real status, driver name and ETA.

With no key configured the bot uses a deterministic rule-based knowledge base
reading the same facts, so support never hard-fails. If the provider errors
mid-request it degrades to that fallback rather than showing an error.

---

## 14. Demo mode

`DEMO_MODE=true` (default in development):

- OTP codes are returned in the API response and printed to the log
- Payments are simulated and marked `isDemo`
- Looser rate limits
- A warning banner is shown in all three apps

**`NODE_ENV=production` force-disables demo mode in `config/env.js`, regardless
of what `.env` says.** Production startup also *refuses to boot* without
Razorpay keys and `CORS_ORIGINS`. Fake payment success is not reachable in
production.

---

## 15. Order state machine

```
PENDING ──▶ CONFIRMED ──▶ DRIVER_ASSIGNED ──▶ DRIVER_ACCEPTED
                                                    │
                                                    ▼
                              DELIVERED ◀── ARRIVING ◀── OUT_FOR_DELIVERY

side states:  PAYMENT_FAILED (retryable)   terminal:  DELIVERED, CANCELLED, FAILED
```

`server/utils/orderStateMachine.js` is the single authority. Every transition is
checked against both the edge **and** the acting role. Some enforced rules:

- A customer cannot go `PENDING → DELIVERED`, or confirm their own order.
- A customer may cancel up to `DRIVER_ASSIGNED`, not once the tanker is rolling.
- A driver acts only on the delivery leg, and only on orders assigned to them.
- Terminal orders cannot be reopened by anyone, admin included.
- A driver rejecting a job returns it to `CONFIRMED` for reassignment.

---

## 16. API reference

Responses are always `{ success, data }` or `{ success, error: { code, message } }`.

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/otp/request` | public |
| POST | `/api/auth/otp/verify` | public |
| POST | `/api/auth/admin/login` | public |
| GET/PATCH | `/api/auth/me` | authed |
| POST | `/api/auth/logout` | authed |
| GET | `/api/products`, `/api/service-areas`, `/api/business-info`, `/api/config` | public |
| GET | `/api/serviceability?latitude=&longitude=` | public |
| GET/POST | `/api/addresses` | customer |
| PATCH/DELETE | `/api/addresses/:id` | owner |
| POST/GET | `/api/orders` | customer |
| GET | `/api/orders/active`, `/api/orders/:id`, `/api/orders/:id/track` | owner |
| POST | `/api/orders/:id/cancel` | owner |
| POST | `/api/payments/create`, `/verify`, `/failed` | owner |
| POST | `/api/payments/webhook` | Razorpay (HMAC) |
| GET | `/api/driver/me`, `/api/driver/orders` | driver |
| POST | `/api/driver/orders/:id/status`, `/api/driver/location`, `/api/driver/availability` | driver |
| GET | `/api/admin/stats`, `/live`, `/orders`, `/drivers`, `/vehicles`, `/products`, `/customers`, `/payments`, `/service-areas`, `/stations`, `/business-info`, `/support` | admin |
| POST | `/api/admin/orders/:id/assign-driver`, `/api/admin/orders/:id/status` | admin |
| POST/PATCH/DELETE | `/api/admin/drivers`, `/vehicles`, `/products`, `/service-areas`, `/stations`, `/admins` | admin |
| POST | `/api/chat` | public (order-aware when signed in) |
| GET/POST | `/api/notifications`, `/api/notifications/read` | authed |
| GET | `/api/health` | public |

### Socket.IO

Authenticated at handshake with the JWT; an anonymous socket is rejected.

| Room | Members |
|---|---|
| `user:<userId>` | that user |
| `order:<orderId>` | the customer, the assigned driver, admins |
| `driver:<driverId>` | that driver |
| `admins` | all admins |

Client → server: `order:subscribe` (authorized per order), `order:unsubscribe`,
`driver:location` (drivers only, throttled).
Server → client: `order:update`, `driver:location`, `notification`,
`driver:new-assignment`, `admin:order-new`, `admin:order-update`,
`admin:driver-location`, `admin:driver-status`.

Nothing is ever broadcast to all connected sockets.

---

## 17. Security

- Helmet with an explicit CSP allow-listing Google Maps, Razorpay and Socket.IO
- CORS allow-list, required in production
- Rate limits: global, plus tighter limits on OTP request/verify, admin login,
  payments, chat and GPS
- Zod validates every body/query/param and **replaces** the request object, so a
  handler cannot read an unvalidated extra field
- JWT carries only a user id; role and active status are re-read from the
  database on every request, so revocation is immediate
- Role-based middleware; `/api/admin/*` and `/api/driver/*` are gated wholesale
- Ownership checks are centralised in `getAuthorizedOrder()`
- Cross-customer reads return `404`, not `403`, so ids cannot be enumerated
- Admin passwords are bcrypt (cost 12); login uses a dummy-hash comparison so
  timing does not reveal whether an account exists
- OTPs are stored as salted SHA-256 hashes, compared in constant time, single-use,
  attempt-limited and expiring
- Logs redact anything matching password/secret/token/key/signature
- Stack traces are never returned in production
- `0 npm vulnerabilities`

The backend never trusts client-supplied `userId`, `role`, `price`, `status`,
order ownership or payment state.

---

## 18. Testing

```bash
# terminal 1
npm run dev

# terminal 2
npm test
```

53 tests: order state machine, geo/ETA, phone normalization, auth, RBAC,
address privacy, server-side pricing, cross-customer isolation, demo payment
idempotency, chatbot grounding and order-context scoping, admin dispatch,
Socket.IO room authorization and live GPS delivery, and water-station
routing (nearest-station selection, route progress, admin-only access).

Admin and realtime tests need `ADMIN_SEED_PASSWORD` and `DRIVER_SEED_PHONE` in
the environment; they skip cleanly without them.

---

## 19. Production deployment

1. **Database** — managed PostgreSQL (RDS, Cloud SQL, Neon, Supabase, Railway).
   Set `DATABASE_URL`, then `npx prisma migrate deploy`.
2. **Environment** — `NODE_ENV=production`, a fresh 48-byte `JWT_SECRET`, real
   Razorpay keys, `CORS_ORIGINS`, `TRUST_PROXY=true` behind a proxy. Startup
   refuses to boot if any of these are missing.
3. **App** — any Node host (Render, Railway, Fly.io, EC2, App Service).
   Build command `npm ci && npx prisma generate`, start command `npm start`.
   Because Express serves `client/`, one service covers both tiers.
4. **HTTPS** — required: geolocation and secure cookies need it. Terminate at
   the platform or at nginx.
5. **SMS** — set `SMS_PROVIDER_KEY` and implement `deliverCode()` in
   `server/services/otp.service.js`. Without it, OTP cannot be delivered in
   production and login will fail by design rather than fall back to mock codes.
6. **Maps** — restrict the browser key to your production domain.
7. **Webhook** — point Razorpay at `/api/payments/webhook`.
8. **Health check** — point the platform's probe at `/api/health`; it returns
   503 when the database is unreachable.

### Scaling

Socket.IO currently runs single-process. To run more than one instance, add
Redis and the Socket.IO Redis adapter so rooms span instances. Redis is
deliberately **not** in `docker-compose.yml` — a single process does not need it,
and unused services are a liability.

---

## 20. Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL is not set` | `cp .env.example .env` and fill it in |
| `JWT_SECRET is not set` | Generate one (§7) |
| `Can't reach database server` | `docker compose up -d`; check the port in `DATABASE_URL` matches compose (5434) |
| `Port 3000 is already in use` | Change `PORT`, or stop the other process |
| `EPERM ... query_engine.dll` on `prisma generate` | The server is holding the engine open — stop it, regenerate, restart |
| npm blocked Prisma install scripts | `npm approve-scripts prisma @prisma/client @prisma/engines` |
| Map area is a striped placeholder | No `GOOGLE_MAPS_API_KEY`. Everything else still works |
| `This IP, site or mobile application is not authorized` | Add `http://localhost:3000/*` to the key's referrer restrictions |
| No OTP received | In demo mode it is on screen and in the log; in production configure `SMS_PROVIDER_KEY` |
| Live tracking not moving | Driver must be online **and** have location sharing on; the driver's browser needs HTTPS (or localhost) for geolocation |
| Chatbot says it lacks information | Expected when the fact is not in the knowledge base — add it in Admin → Chatbot & info |
| Payment window does not open | Razorpay's script was blocked; the order is still saved and payable from *My orders* |
| Admin password lost | `npm run db:seed` after setting `ADMIN_SEED_PASSWORD` only creates a *new* admin; to reset, delete the user row and re-seed, or use `POST /api/admin/admins` from an existing admin session |

---

## 21. What changed from v1

| | v1 | v2 |
|---|---|---|
| Database | MongoDB (never connected) | PostgreSQL + Prisma, 14 models, indexed |
| Auth | Phone-only, no verification, no token | OTP + JWT, RBAC, bcrypt admin |
| Pricing | Hardcoded in HTML, sent by client | Database-driven, server-authoritative |
| Payments | Secret in source; fake success on error | Env-based, signature-verified, idempotent |
| Order status | Any client could set any value | Validated state machine with role rules |
| Realtime | `io.emit()` to everyone | Authorized rooms, throttled GPS |
| Tracking | None | Live map, route, distance, ETA |
| Admin | 26-line list | Full console: dispatch, fleet, pricing, reports |
| Driver | 38-line list, no auth | Authenticated app with GPS and job workflow |
| Chatbot | None | Grounded, order-aware, provider-agnostic |
| Validation | None | Zod on every endpoint |
| Security | None | Helmet, CORS, rate limits, RBAC, redacted logs |
| Tests | None | 48 automated |
