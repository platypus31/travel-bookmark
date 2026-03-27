@AGENTS.md

## Project: Travel Bookmark 旅遊收藏

家庭共享美食景點收藏平台。收藏 IG/小紅書/YouTube 連結，依台灣縣市區域篩選。

### Quick Reference

- **Stack**: Next.js 16 + TypeScript + Tailwind CSS + Supabase
- **Deploy**: Vercel (manual `vercel --prod`)
- **DB**: Supabase project `YOUR_SUPABASE_PROJECT_ID` (ap-northeast-1)
- **Prod URL**: https://travel-bookmark-sigma.vercel.app
- **Handoff doc**: See `HANDOFF.md` for full status, TODOs, and architecture details

### Key Patterns

- All state management is client-side in `page.tsx` (no server components for data)
- Auth flow: AuthForm → SetupProfile → main app (all in page.tsx)
- RLS on Supabase: bookmarks scoped to group_id, profiles scoped to user
- Taiwan city/district data lives in `src/lib/types.ts` CITIES constant
- Platform detection by URL pattern in `src/lib/utils.ts`

### Dev Commands

```bash
npm run dev        # localhost:3000
npm run build      # production build
vercel --prod      # deploy
```

### Environment Variables (Vercel + .env.local)

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
