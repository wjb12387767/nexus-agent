/**
 * History API Routes
 *
 * Provides endpoints for rewinding to a specific message and editing user
 * questions. The backend handles file-system checkpoint restoration while the
 * frontend (via Tauri SQL plugin) handles message database operations.
 */

import * as fs from 'fs/promises';
import { Hono } from 'hono';
import * as path from 'path';

import { APP_DIR_NAME, SESSIONS_DIR_NAME, getHomeDir } from '@/config/constants';

const history = new Hono();

interface RewindRequest {
  taskId: string;
  messageId: number;
  /** File paths that were modified by tool calls after messageId */
  filePaths?: string[];
}

interface EditRequest {
  taskId: string;
  messageId: number;
  newContent: string;
}

/**
 * Resolve the session folder for a given task.
 * Sessions live under ~/.workany/sessions/<task-id> (or session subfolder).
 */
function resolveSessionDir(taskId: string): string {
  return path.join(getHomeDir(), APP_DIR_NAME, SESSIONS_DIR_NAME, taskId);
}

/**
 * Attempt to restore files from .bak checkpoints in the session directory.
 * Returns the list of files that were restored.
 */
async function restoreCheckpoints(
  sessionDir: string,
  filePaths: string[]
): Promise<string[]> {
  const restored: string[] = [];

  for (const filePath of filePaths) {
    // Resolve relative to session dir if not absolute
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(sessionDir, filePath);
    const bakPath = fullPath + '.bak';

    try {
      await fs.access(bakPath);
      await fs.copyFile(bakPath, fullPath);
      restored.push(fullPath);
    } catch {
      // No checkpoint exists for this file — skip
    }
  }

  return restored;
}

/**
 * Rewind to a specific message.
 *
 * The frontend sends the taskId, messageId, and file paths extracted from
 * tool_use messages (Write/Edit) that occurred after the target message.
 * The backend restores any .bak checkpoints for those files.
 *
 * The actual deletion of messages from the database is handled by the frontend
 * (via the Tauri SQL plugin), so this endpoint focuses on file rollback.
 */
history.post('/rewind', async (c) => {
  const body = await c.req.json<RewindRequest>();
  const { taskId, filePaths } = body;

  if (!taskId) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  const sessionDir = resolveSessionDir(taskId);
  const filesToRestore = filePaths || [];

  let restoredFiles: string[] = [];
  if (filesToRestore.length > 0) {
    try {
      restoredFiles = await restoreCheckpoints(sessionDir, filesToRestore);
    } catch (error) {
      console.error('[HistoryAPI] Failed to restore checkpoints:', error);
    }
  }

  return c.json({
    success: true,
    taskId,
    sessionDir,
    restoredFiles,
    message: `Rewind prepared. ${restoredFiles.length} file(s) restored from checkpoints.`,
  });
});

/**
 * Edit a user message.
 *
 * The frontend updates the message content and deletes subsequent messages via
 * the Tauri SQL plugin. This endpoint acknowledges the edit and returns the
 * session directory for any file cleanup if needed.
 */
history.post('/edit', async (c) => {
  const body = await c.req.json<EditRequest>();
  const { taskId, messageId, newContent } = body;

  if (!taskId || !messageId) {
    return c.json({ error: 'taskId and messageId are required' }, 400);
  }

  if (!newContent || newContent.trim().length === 0) {
    return c.json({ error: 'newContent must not be empty' }, 400);
  }

  const sessionDir = resolveSessionDir(taskId);

  return c.json({
    success: true,
    taskId,
    messageId,
    sessionDir,
    message: 'Edit acknowledged. Frontend should update DB and re-run agent.',
  });
});

/**
 * Get history metadata for a task (session folder info).
 */
history.get('/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  const sessionDir = resolveSessionDir(taskId);

  let dirExists = false;
  let fileCount = 0;
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    dirExists = true;
    fileCount = entries.filter((e) => e.isFile()).length;
  } catch {
    // Directory doesn't exist
  }

  return c.json({
    taskId,
    sessionDir,
    exists: dirExists,
    fileCount,
  });
});

export { history as historyRoutes };
