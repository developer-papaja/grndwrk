/**
 * Optional: let people in through Cloudflare Access instead of tokens.
 *
 * Access puts a signed JWT on every request it lets through
 * (`Cf-Access-Jwt-Assertion`). This checks that JWT against the team's keys
 * and the application's audience, and takes the email from it, never from
 * the `Cf-Access-Authenticated-User-Email` header, which anyone can send to
 * a Worker that is also reachable without Access (workers.dev). The email
 * then gets a role from ACCESS_ROLES:
 *
 *   {"clinic": {"vet@clinic.example": "write", "*@clinic.example": "read"}}
 *
 * A comment role through Access names the commenter after a hash of the
 * email, and the email is the name grndwrk shows. Requests with a token
 * never get here.
 */
import { type Identify, type Role, sha256 } from './store.js'

interface Jwk { kid: string; kty: string; n: string; e: string }

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const decode = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>

export function access(
  options: { team: string; aud: string; roles: string },
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Identify {
  // The team's own domain only, so a setting cannot send the check elsewhere.
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(options.team)) throw new Error('ACCESS_TEAM is <team>.cloudflareaccess.com')
  const roles = JSON.parse(options.roles) as Record<string, Record<string, Role>>
  let keys: { at: number; list: Jwk[] } | null = null
  // `fresh`: a key id not seen yet, maybe a rotated key; fetched again at most once a minute, so a stranger's tokens cannot make it fetch on every request.
  const certs = async (fresh = false): Promise<Jwk[]> => {
    if (keys && now() - keys.at < 3_600_000 && !(fresh && now() - keys.at >= 60_000)) return keys.list
    const res = await fetcher(`https://${options.team}/cdn-cgi/access/certs`)
    if (!res.ok) throw new Error(`Access certs: ${res.status}`)
    keys = { at: now(), list: ((await res.json()) as { keys: Jwk[] }).keys }
    return keys.list
  }

  return async (req, project) => {
    const jwt = req.headers.get('cf-access-jwt-assertion') ?? ''
    const [head, body, sig] = jwt.split('.')
    if (!head || !body || !sig) return null
    let header: Record<string, unknown>
    let claims: Record<string, unknown>
    try {
      header = decode(head)
      claims = decode(body)
    } catch {
      return null
    }
    if (header.alg !== 'RS256') return null
    const jwk = (await certs()).find((k) => k.kid === header.kid) ?? (await certs(true)).find((k) => k.kid === header.kid)
    if (!jwk) return null
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${head}.${body}`)))) return null
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(options.aud) || claims.iss !== `https://${options.team}` || typeof claims.exp !== 'number' || claims.exp * 1000 < now()) return null
    // Not before: a token made for later is no token yet.
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf * 1000 > now())) return null
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    const allowed = roles[project] ?? {}
    const role = allowed[email] ?? allowed[`*@${email.split('@')[1]}`]
    if (!email || (role !== 'read' && role !== 'write' && role !== 'comment')) return null
    return role === 'comment' ? { role, commenter: `access_${(await sha256(email)).slice(0, 32)}`, name: email } : { role }
  }
}
