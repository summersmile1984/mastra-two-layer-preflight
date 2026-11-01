export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export const env=new Proxy({}, {get:()=>undefined}); export const waitUntil=()=>{};', shortCircuit: true };
  return next(spec, ctx);
}
