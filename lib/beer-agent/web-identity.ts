import { randomUUID } from 'node:crypto';

/** Anonymous browser identity for long-term preferences; active menus also require conversationId. */
export function resolveWebIdentity(request: Request): {userId:string;setCookie?:string} {
  const cookie = request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('beer_lens_user='))?.slice('beer_lens_user='.length);
  if(cookie && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cookie)) return {userId:`web_${cookie.toLowerCase()}`};
  const id=randomUUID();
  return {userId:`web_${id}`,setCookie:`beer_lens_user=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${new URL(request.url).protocol==='https:'?'; Secure':''}`};
}
