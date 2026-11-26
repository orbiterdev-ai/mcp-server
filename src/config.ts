import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const AutoApprovalRuleSchema = z.object({
  pattern: z.string(),
  description: z.string().optional(),
});

const ConfigSchema = z.object({
  auto_approval: z.array(AutoApprovalRuleSchema).optional(),
  /**
   * User-level opt-in required before workspace-level orbiter.config.json or
   * .orbiter.json auto_approval rules are even considered as server hints.
   * Defaults to false so untrusted repositories cannot loosen user policy.
   */
  allow_workspace_auto_approval: z.boolean().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadConfigOptions {
  cwd?: string;
  homeDir?: string;
  userConfigPath?: string;
}

function readConfigFile(filePath: string): Config | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);
    return ConfigSchema.parse(json);
  } catch (e) {
    console.error(`Failed to load config from ${filePath}:`, e);
    return undefined;
  }
}

/**
 * Load Orbiter client policy configuration with strict trust precedence:
 * 1. User-level config (~/.orbiter/config.json or ORBITER_CONFIG_PATH) is authoritative.
 * 2. Repository/workspace-level config files (orbiter.config.json, .orbiter.json)
 *    cannot override or loosen user policy unless the user-level config explicitly
 *    sets `allow_workspace_auto_approval: true`.
 *
 * Note: Matching auto_approval rules only send an advisory hint to the Orbiter
 * server; the server's recorded terminal decision remains authoritative.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const homeDir = options.homeDir ?? (process.env.HOME || process.env.USERPROFILE || '.');
  const cwd = options.cwd ?? process.cwd();
  const userConfigPath =
    options.userConfigPath ??
    process.env.ORBITER_CONFIG_PATH ??
    path.join(homeDir, '.orbiter', 'config.json');

  const userConfig = readConfigFile(userConfigPath) ?? {};
  const userRules = userConfig.auto_approval ?? [];

  if (userConfig.allow_workspace_auto_approval !== true) {
    return {
      ...(userRules.length > 0 ? { auto_approval: userRules } : {}),
      ...(userConfig.allow_workspace_auto_approval !== undefined
        ? { allow_workspace_auto_approval: userConfig.allow_workspace_auto_approval }
        : {}),
    };
  }

  const workspaceLocations = [
    path.join(cwd, 'orbiter.config.json'),
    path.join(cwd, '.orbiter.json'),
  ];

  const mergedRules = [...userRules];
  for (const loc of workspaceLocations) {
    const workspaceConfig = readConfigFile(loc);
    if (workspaceConfig?.auto_approval?.length) {
      mergedRules.push(...workspaceConfig.auto_approval);
      break;
    }
  }

  return {
    allow_workspace_auto_approval: true,
    ...(mergedRules.length > 0 ? { auto_approval: mergedRules } : {}),
  };
}

export function shouldAutoApprove(config: Config, text: string): boolean {
  if (!config.auto_approval || config.auto_approval.length === 0) return false;

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
