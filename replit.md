# cloudfunctio — Express Backend API

## Overview
Node.js/Express backend server handling:
- **Paystack** payment webhooks, subscription lifecycle, and payment verification
- **Supabase** for user, subscription, and payment data storage
- **NVIDIA AI API** (via OpenAI client) for brand-aware AI chat with memory summaries

Entry point: `index.js`  
Default port: `8000` (or `PORT` env var)

## Required Environment Variables
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (admin) key |
| `NVIDIA_API_KEY` | NVIDIA API key for AI completions |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (webhooks + API calls) |
| `ALLOWED_ORIGIN` | Frontend origin allowed by CORS (e.g. `https://your-frontend.com`) |
| `SESSION_SECRET` | Secret for session signing |

## Running the Server
```bash
node index.js
```

## API Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | Health check |
| `POST` | `/api/user/sync` | Bearer token | Sync Supabase auth user, return plan |
| `POST` | `/ai/chat` | Bearer token | Brand-aware AI chat + memory |
| `POST` | `/verify-payment` | Bearer token | Verify Paystack transaction |
| `POST` | `/cancel-subscription` | Bearer token | Cancel Paystack subscription |
| `POST` | `/paystack/webhook` | Paystack HMAC | Handle payment/subscription events |

## Security Notes
- CORS is locked to `ALLOWED_ORIGIN` env var (no wildcard)
- `helmet` adds standard security headers
- Paystack webhook validated with HMAC-SHA512 timing-safe comparison
- All authenticated routes require a valid Supabase JWT

## User Preferences
