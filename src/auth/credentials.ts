import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Persisted credentials for Orbiter Dev
 */
export interface OrbiterCredentials {
  api_key: string;
  user_id: string;
  paired_at: string;
  backend_url: string;
}

/**
 * Platform-aware path resolution for credentials
 */
export function getCredentialPath(): string {
  const runtimeEnv = process['env'];
  const explicitPath = runtimeEnv.ORBITER_CREDENTIAL_PATH;
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath);
  }

  const profile = sanitizeCredentialProfile(runtimeEnv.ORBITER_CREDENTIAL_PROFILE);
  if (profile) {
    const homeDir = os.userInfo().homedir || runtimeEnv.USERPROFILE || runtimeEnv.HOME || '';
    return path.join(homeDir, '.orbiter', 'profiles', profile, 'credentials');
  }
  const homeDir = os.userInfo().homedir || process.env.USERPROFILE || process.env.HOME || '';
  return path.join(homeDir, '.orbiter', 'credentials');
}

function sanitizeCredentialProfile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return normalized.length > 0 ? normalized.slice(0, 48) : undefined;
}

/**
 * Read and parse credentials, return null if missing/invalid
 */
export function loadCredentials(): OrbiterCredentials | null {
  const credPath = getCredentialPath();
  if (!fs.existsSync(credPath)) {
    return null;
  }
  
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    if (creds && creds.api_key && creds.user_id && creds.backend_url) {
      return creds as OrbiterCredentials;
    }
  } catch (error) {
    console.error(`Failed to parse credentials at ${credPath}:`, error);
  }
  
  return null;
}

/**
 * Write credentials with restrictive permissions (0600)
 */
export function saveCredentials(creds: OrbiterCredentials): void {
  const credPath = getCredentialPath();
  const dir = path.dirname(credPath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  
  const payload = JSON.stringify(creds, null, 2);
  fs.writeFileSync(credPath, payload, { mode: 0o600 });
}

/**
 * Lightweight check to verify key is still valid
 */
export async function validateCredentials(creds: OrbiterCredentials): Promise<boolean> {
  try {
    const response = await fetch(`${creds.backend_url}/api/v1/approvals?limit=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${creds.api_key}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      return true;
    }
    
    // Explicit 401 means revoked or invalid
    if (response.status === 401) {
      return false;
    }
    
    // For other errors (networking, 5xx), assume temporal failure
    return true; 
  } catch (err) {
    // Network error, keep the credential
    return true; 
  }
}
