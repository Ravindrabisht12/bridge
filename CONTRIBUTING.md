# Contributing to Bridge

Thanks for helping. Bug reports, fixes and new client integrations are all welcome.

## Setup

You need Node.js 22.14 or newer (`nvm use` reads `.nvmrc`).

```bash
npm install
npm run dev
```

The app keeps its data in your user data directory (see the README). To run a
second, throwaway copy without touching it, set `BRIDGE_HOME` to an empty
directory and `BRIDGE_ALLOW_MULTIPLE=1`.

## Before you open a pull request

```bash
npm run typecheck:all
npm run lint
npm run test:all
npm run test:e2e     # builds the app and drives the real proxy and window
```

All four should pass. CI runs the same steps.

## What a good change looks like

- **Read [ARCHITECTURE.md](ARCHITECTURE.md) first** for anything touching the
  proxy, policy or control socket. It explains why things are the way they are,
  including several approaches that were tried and failed.
- **Tests with the change.** Security behaviour especially: a fix that is not
  pinned by a test tends to come undone.
- **Fail closed.** When Bridge cannot decide safely, it blocks and says why.
- **No telemetry, no accounts, no calls home.** Bridge must keep working
  offline and must never send what it records anywhere.
- **Keep it focused.** One concern per pull request is easiest to review.

Found a security problem? Please follow [SECURITY.md](SECURITY.md) instead of
opening an issue.
