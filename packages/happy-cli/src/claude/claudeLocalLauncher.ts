import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { getProjectPath } from "./utils/path";
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => { 
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
            }
        }
    });
    
    // Register callback to notify scanner when session ID is found via hook
    // This is important for --continue/--resume where session ID is not known upfront
    const scannerSessionCallback = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(scannerSessionCallback);

    // For custom backends that don't support --settings, use directory watching
    // combined with lsof PID verification to discover session IDs.
    // The PID check ensures we only claim .jsonl files opened by OUR child process,
    // avoiding race conditions when multiple Happy instances run concurrently.
    const backendName = process.env.HAPPY_CLAUDE_BACKEND || 'claude';
    const isCustomBackend = backendName !== 'claude';
    let dirWatcherCleanup: (() => void) | null = null;
    let childPid: number | null = null;

    // Helper: check if a given PID (or any of its descendants) has a file open
    function isFileOpenByPid(pid: number, filePath: string): Promise<boolean> {
        return new Promise((resolve) => {
            // Use lsof to check if the process tree has the file open
            // -p: filter by PID, +D would be too broad; we grep the output instead
            execFile('lsof', ['-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
                if (err) {
                    // lsof returns exit code 1 when no files found for PID, which is normal
                    resolve(false);
                    return;
                }
                resolve(stdout.includes(filePath));
            });
        });
    }

    // Helper: verify and claim a new .jsonl file via lsof
    async function verifyAndClaimSession(filename: string, knownFiles: Set<string>, projectDir: string) {
        if (!filename.endsWith('.jsonl') || knownFiles.has(filename)) return;
        if (!childPid) {
            logger.debug(`[local] Custom backend: found new file '${filename}' but child PID not yet known, skipping`);
            return;
        }

        const fullPath = join(projectDir, filename);
        const isOurs = await isFileOpenByPid(childPid, fullPath);
        if (!isOurs) {
            logger.debug(`[local] Custom backend: file '${filename}' not opened by PID ${childPid}, ignoring`);
            return;
        }

        const sessionId = filename.replace('.jsonl', '');
        logger.debug(`[local] Custom backend: verified '${filename}' belongs to PID ${childPid} → session ID: ${sessionId}`);
        knownFiles.add(filename);
        session.onSessionFound(sessionId);
        scanner.onNewSession(sessionId);
    }

    if (isCustomBackend) {
        const projectDir = getProjectPath(session.path);
        // Take a snapshot of existing .jsonl files before Claude starts
        let knownFiles = new Set<string>();
        try {
            const files = await readdir(projectDir);
            for (const f of files) {
                if (f.endsWith('.jsonl')) {
                    knownFiles.add(f);
                }
            }
        } catch {
            // Directory may not exist yet
        }
        logger.debug(`[local] Custom backend '${backendName}': watching ${projectDir} for new .jsonl files with PID verification (${knownFiles.size} existing)`);

        // Watch the project directory for new .jsonl files
        let fsWatcher: ReturnType<typeof watch> | null = null;
        try {
            fsWatcher = watch(projectDir, (eventType, filename) => {
                if (!filename) return;
                verifyAndClaimSession(filename, knownFiles, projectDir);
            });
        } catch {
            logger.debug(`[local] Custom backend: could not watch ${projectDir}, will poll`);
        }

        // Also poll periodically as a safety net (some OS/FS combos miss events)
        const pollInterval = setInterval(async () => {
            try {
                const files = await readdir(projectDir);
                for (const f of files) {
                    await verifyAndClaimSession(f, knownFiles, projectDir);
                }
            } catch {
                // Directory may not exist yet
            }
        }, 2000);

        dirWatcherCleanup = () => {
            fsWatcher?.close();
            clearInterval(pollInterval);
        };
    }

    // Handle abort
    let exitReason: LauncherResult | null = null;
    const processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    try {
        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exutFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }

            session.client.closeClaudeSessionTurn('cancelled');

            // Reset sent messages
            session.queue.reset();

            // Abort
            await abort();
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }

            session.client.closeClaudeSessionTurn('cancelled');

            // Abort
            await abort();
        }

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process, clean queue and switch to remote mode
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When user wants to switch to remote mode
        session.queue.setOnMessage((message: string, mode) => {
            // Switch to remote mode when message received
            doSwitch();
        }); // When any message is received, abort current process, clean queue and switch to remote mode

        // Exit if there are messages in the queue
        if (session.queue.size() > 0) {
            return { type: 'switch' };
        }

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        }

        // Run local mode
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange: session.onThinkingChange,
                    onChildPid: (pid) => {
                        childPid = pid;
                        logger.debug(`[local] Claude child process PID: ${pid}`);
                    },
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                    sandboxConfig: session.sandboxConfig,
                });

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // Normal exit
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('completed');
                    exitReason = { type: 'exit', code: 0 };
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);
                // If Claude exited with non-zero exit code, propagate it
                if (e instanceof ExitCodeError) {
                    // If exitReason was already set by doSwitch/doAbort, don't override it —
                    // the ExitCodeError is just a side effect of aborting the subprocess.
                    if (!exitReason) {
                        session.client.closeClaudeSessionTurn('failed');
                        exitReason = { type: 'exit', code: e.exitCode };
                    }
                    break;
                }
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    continue;
                } else {
                    break;
                }
            }
            logger.debug('[local]: launch done');
        }
    } finally {

        // Resolve future
        exutFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        session.queue.setOnMessage(null);
        
        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup directory watcher (for custom backends)
        dirWatcherCleanup?.();

        // Cleanup
        await scanner.cleanup();
    }

    // Return
    return exitReason || { type: 'exit', code: 0 };
}
