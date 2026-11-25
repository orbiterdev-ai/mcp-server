export const MCP_PACKAGE_VERSION = '0.1.14';

export function mcpComponentVersion(component: string): string {
  return `mcp-${component}-${MCP_PACKAGE_VERSION}`;
}
