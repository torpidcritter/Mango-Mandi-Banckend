// "Sign in with Google": the browser gets an ID token (a JWT signed by Google)
// from Google Identity Services and sends it here. We check Google's signature,
// that it was issued for our client ID, and that the email is verified.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { env } from './env.js'
import { HttpError, unauthorized } from './errors.js'

let keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

/** Tests sign their own tokens. */
export function useGoogleKeys(k) {
  keys = k
}

export const googleOn = () => Boolean(env.GOOGLE_CLIENT_ID)

/** Returns { sub, email, name } from a verified Google ID token. */
export async function verifyGoogleCredential(credential) {
  if (!googleOn()) throw new HttpError(503, 'GOOGLE_OFF', 'Sign in with Google is not set up.')
  let payload
  try {
    ;({ payload } = await jwtVerify(String(credential ?? ''), keys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID.split(',').map((s) => s.trim()),
      algorithms: ['RS256'],
    }))
  } catch {
    throw unauthorized('Google sign-in failed. Please try again.', 'GOOGLE_INVALID')
  }
  if (!payload.sub || !payload.email || payload.email_verified !== true) {
    throw unauthorized('Your Google account email is not verified.', 'GOOGLE_UNVERIFIED')
  }
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), name: payload.name ? String(payload.name).slice(0, 80) : null }
}
