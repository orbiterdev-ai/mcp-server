
/**
 * Handle 'notify' CLI command
 * Usage: orbiter-bridge notify --event "Title" --message "Body"
 */
export async function handleNotifyCommand(args: string[]): Promise<void> {
    let event = "Notification";
    let message = "Test Message";
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--event' && args[i+1]) {
            event = args[i+1];
            i++;
        }
        if (args[i] === '--message' && args[i+1]) {
            message = args[i+1];
            i++;
        }
    }
    
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';
    const token = process.env.ORBITER_TOKEN;
    
    if (!token) {
        console.error("Error: ORBITER_TOKEN environment variable is required.");
        process.exit(1);
    }
    
    try {
        const response = await fetch(`${serverUrl}/api/v1/notify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ event, message })
        });
        
        if (response.ok) {
            console.log("Notification sent.");
        } else {
            console.error(`Failed to send notification: ${response.status} ${response.statusText}`);
            const text = await response.text();
            console.error(text);
            process.exit(1);
        }
    } catch (err: any) {
        console.error("Network error:", err.message);
        process.exit(1);
    }
}
