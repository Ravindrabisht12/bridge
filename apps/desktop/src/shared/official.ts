/**
 * Re-exported so every existing `@shared/official` import keeps working. The
 * list itself lives in `@bridge/catalogue-data`, because the catalogue worker
 * seeds the same 55 entries and a second copy would drift.
 */
export * from '@bridge/catalogue-data'
