import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const ConfigSchema = z.object({
  auto_approval: z.array(z.object({
    pattern: z.string(),
    description: z.string().optional()
  })).optional()
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  // Look in current directory and home directory
  const locations = [
    path.join(process.cwd(), 'orbiter.config.json'),
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.orbiter', 'config.json')
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      try {
        const content = fs.readFileSync(loc, 'utf-8');
        const json = JSON.parse(content);
        return ConfigSchema.parse(json);
      } catch (e) {
        console.error(`Failed to load config from ${loc}:`, e);
      }
    }
  }

  return {};
}

export function shouldAutoApprove(config: Config, text: string): boolean {
    if (!config.auto_approval) return false;
    
    for (const rule of config.auto_approval) {
        try {
            const regex = new RegExp(rule.pattern, 'i');
            if (regex.test(text)) {
                return true;
            }
        } catch (e) {
            console.error(`Invalid regex pattern: ${rule.pattern}`, e);
        }
    }
    return false;
}
