/**
 * Re-exported so existing imports keep working. The discovery itself lives in
 * `@bridge/favicon`, because the catalogue worker now resolves the same icons
 * centrally and a second copy would drift.
 */
export * from '@bridge/favicon'
