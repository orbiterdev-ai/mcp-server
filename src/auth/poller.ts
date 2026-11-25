export async function pollForAuth(
  backendUrl: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number
): Promise<{ api_key: string; user_id: string }> {
  // Use a sensible default max timeout
  const maxWaitMs = expiresInSeconds * 1000;
  const start = Date.now();
  let currentIntervalMs = intervalSeconds * 1000;

  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetch(`${backendUrl}/api/v1/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`);
      
      if (!response.ok) {
        if (response.status >= 500) {
          // Server error, back off and retry
          currentIntervalMs = Math.min(currentIntervalMs * 1.5, 30000); // Max backoff 30s
        }
      } else {
        const jsonResponse: any = await response.json();
        const data = jsonResponse.data || jsonResponse; // Unwrap API format
        
        // Ensure status handles edge case where backend doesn't send it correctly
        const status = data?.status || (data?.api_key ? 'authorized' : 'authorization_pending');

        switch (status) {
          case 'authorization_pending':
            // keep polling
            break;
          case 'slow_down':
            // increase interval by 5 sec as per RFC 8628
            currentIntervalMs += 5000;
            break;
          case 'authorized':
            if (!data.api_key || !data.user_id) {
                throw new Error('Authorized response missing api_key or user_id');
            }
            return {
              api_key: data.api_key,
              user_id: data.user_id
            };
          case 'expired_token':
            throw new Error('Code expired, please try again');
          case 'access_denied':
            throw new Error('User denied the pairing request');
          default:
            // unknown status, keep polling
            break;
        }
      }
    } catch (err: any) {
      // Manual error triggers
      if (err.message && (err.message.includes('expired') || err.message.includes('denied'))) {
          throw err;
      }
      // On network errors, exponential backoff
      currentIntervalMs = Math.min(currentIntervalMs * 1.5, 30000);
    }

    // Wait for the next poll
    await new Promise(resolve => setTimeout(resolve, currentIntervalMs));
  }

  throw new Error('Polling timed out.');
}
