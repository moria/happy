/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 * 
 * For custom backends (e.g. claude-internal) that strip --settings flag,
 * hooks are injected directly into the backend's own settings.json.
 */

import { join, resolve } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { getClaudeConfigDir } from './path';

/**
 * Build the hooks object for SessionStart
 */
function buildHooksConfig(port: number) {
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;
    return {
        SessionStart: [
            {
                matcher: "*",
                hooks: [
                    {
                        type: "command",
                        command: hookCommand
                    }
                ]
            }
        ]
    };
}

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const settings = {
        hooks: buildHooksConfig(port)
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

/**
 * Inject SessionStart hook directly into the backend's settings.json.
 * Used for custom backends (e.g. claude-internal) that strip --settings flag.
 * 
 * Reads existing settings, merges hooks, writes back.
 * 
 * @param port - The port where Happy hook server is listening
 * @returns Path to the modified settings file (for cleanup)
 */
export function injectHookIntoBackendSettings(port: number): string {
    const settingsPath = join(getClaudeConfigDir(), 'settings.json');

    let settings: Record<string, any> = {};
    try {
        if (existsSync(settingsPath)) {
            settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        }
    } catch {
        settings = {};
    }

    // Merge hooks (preserve existing settings)
    settings.hooks = buildHooksConfig(port);

    mkdirSync(join(getClaudeConfigDir()), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Injected hooks into backend settings: ${settingsPath}`);

    return settingsPath;
}

/**
 * Remove SessionStart hook from the backend's settings.json.
 * Restores the file to its original state (minus hooks).
 * 
 * @param settingsPath - Path to the settings file to clean
 */
export function removeHookFromBackendSettings(settingsPath: string): void {
    try {
        if (!existsSync(settingsPath)) return;

        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (settings && typeof settings === 'object' && settings.hooks) {
            delete settings.hooks;
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            logger.debug(`[generateHookSettings] Removed hooks from backend settings: ${settingsPath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to remove hooks from backend settings: ${error}`);
    }
}

