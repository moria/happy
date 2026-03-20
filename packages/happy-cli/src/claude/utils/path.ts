import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = getClaudeConfigDir();
    return join(claudeConfigDir, 'projects', projectId);
}

/**
 * Get the Claude config directory, respecting custom backends.
 * - CLAUDE_CONFIG_DIR env var takes highest priority
 * - For custom backends (e.g. claude-internal), uses ~/.claude-internal/
 * - Default: ~/.claude/
 */
export function getClaudeConfigDir(): string {
    if (process.env.CLAUDE_CONFIG_DIR) {
        return process.env.CLAUDE_CONFIG_DIR;
    }
    const backendName = process.env.HAPPY_CLAUDE_BACKEND || 'claude';
    return join(homedir(), `.${backendName}`);
}