import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWebIdentity } from '../lib/beer-agent/web-identity.ts';
test('anonymous browsers receive different identities and a private cookie',()=>{
 const a=resolveWebIdentity(new Request('http://localhost/api/chat'));const b=resolveWebIdentity(new Request('http://localhost/api/chat'));
 assert.notEqual(a.userId,b.userId);assert.match(a.setCookie!,/HttpOnly/);assert.match(a.setCookie!,/SameSite=Lax/);
});
test('a browser cookie retains identity across turns without using the shared anon profile',()=>{
 const a=resolveWebIdentity(new Request('http://localhost/api/chat'));
 const b=resolveWebIdentity(new Request('http://localhost/api/chat',{headers:{cookie:a.setCookie!.split(';')[0]}}));
 assert.equal(a.userId,b.userId);assert.notEqual(b.userId,'anon');assert.equal(b.setCookie,undefined);
});
test('invalid cookie values are replaced and HTTPS cookies are secure',()=>{
 const a=resolveWebIdentity(new Request('https://example.test/api/chat',{headers:{cookie:'beer_lens_user=../../anon'}}));
 assert.match(a.setCookie!,/Secure/);assert.ok(!a.userId.includes('/'));
});
