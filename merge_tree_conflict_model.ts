/**
 * Parse `git merge-tree` conflict output.
 */

function normalizePath(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function conflictPathFromLine(line: string): string | null {
  const mergeConflictMatch = /\bMerge conflict in\s+(.+)$/.exec(line);
  if (mergeConflictMatch?.[1]) return normalizePath(mergeConflictMatch[1]);

  const deleteModifyMatch = /^CONFLICT\s+\((?:modify\/delete|delete\/modify)\):\s*(.+?)\s+deleted in\b/.exec(line);
  if (deleteModifyMatch?.[1]) return normalizePath(deleteModifyMatch[1]);

  const colonMatch = /^CONFLICT\s+\([^)]+\):\s*(.+)$/.exec(line);
  if (colonMatch?.[1]) return normalizePath(colonMatch[1]);

  return null;
}

export function parseMergeTreeConflicts(
  returncode: number,
  stdout: string,
): Record<string, unknown> {
  const conflictingFiles: string[] = [];
  let markerConflict = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("<<<<<<<")) markerConflict = true;
    if (!line.startsWith("CONFLICT ")) continue;

    const filePath = conflictPathFromLine(line);
    if (filePath && !conflictingFiles.includes(filePath)) conflictingFiles.push(filePath);
  }

  const hasConflicts = conflictingFiles.length > 0 || markerConflict || returncode === 1;
  return {
    has_conflicts: hasConflicts,
    conflicting_files: conflictingFiles,
    conflict_count: conflictingFiles.length,
  };
}
