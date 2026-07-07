/**
 * Pure git reference validation.
 */

/** Validate that a string is a safe git reference name (prevents injection). */
export function validateGitRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;

  const unsafeChars = ["\0", "\n", "\r", " ", "~", "^", ":", "?", "*", "[", "\\", "..", "@{", "//"];
  for (const c of unsafeChars) {
    if (ref.includes(c)) return false;
  }

  if (ref.startsWith(".") || ref.startsWith("/") || ref.endsWith(".") || ref.endsWith("/") || ref.endsWith(".lock")) {
    return false;
  }

  return !(ref.length > 200);
}
