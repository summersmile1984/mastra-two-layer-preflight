// mastra build evaluates the bundle in Node; stub `cloudflare:workers` (env/waitUntil) so build-time analysis doesn't crash.
import { register } from 'node:module'; register(new URL('./cf-workers-stub-hooks.mjs', import.meta.url));
