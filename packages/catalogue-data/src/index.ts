/**
 * The curated directory: 55 servers published by the vendors themselves.
 *
 * Shared because both sides need the same list for different reasons — the
 * desktop app compiles it in so a fresh install has a useful library before it
 * has a network, and the worker seeds it into `curated` so the API can serve
 * the editorial layer the raw registry has none of.
 */
export * from './official'
export * from './icons'
