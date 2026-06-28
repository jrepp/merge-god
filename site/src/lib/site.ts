/**
 * Base path for the site (GitHub Pages project URL).
 *
 * Astro exposes `import.meta.env.BASE_URL`, but its trailing-slash behavior
 * is inconsistent across versions/config values. Always use this normalized
 * helper so links are correct regardless of how `base` is written in config.
 */
const raw = import.meta.env.BASE_URL ?? "/";
export const base = raw.endsWith("/") ? raw : `${raw}/`;
