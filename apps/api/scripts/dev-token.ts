// Mints a short-lived HS256 access token for LOCAL development only, signed with
// AUTH_JWT_SECRET. Real deployments get tokens from the identity provider.
//
//   npm run dev-token -- <user-uuid>
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') {
  console.error('dev-token is disabled when NODE_ENV=production');
  process.exit(1);
}
const secret = process.env.AUTH_JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error('Set AUTH_JWT_SECRET (at least 32 characters) in the environment.');
  process.exit(1);
}

const sub = process.argv[2] ?? randomUUID();
let jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt().setExpirationTime('8h');
if (process.env.AUTH_JWT_ISSUER) jwt = jwt.setIssuer(process.env.AUTH_JWT_ISSUER);
if (process.env.AUTH_JWT_AUDIENCE) jwt = jwt.setAudience(process.env.AUTH_JWT_AUDIENCE);

console.error(`user id: ${sub}`);
console.log(await jwt.sign(new TextEncoder().encode(secret)));
