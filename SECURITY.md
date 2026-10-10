# Security policy

Bridge sits between AI apps and the tools they can use, so a flaw in it can
matter more than in most apps. Thank you for looking.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:
open the repository's **Security** tab and choose **Report a vulnerability**.

Include what you can of:

- what an attacker can do, and what they need first (a local account, a
  malicious MCP server, a crafted registry entry, …)
- steps or a proof of concept
- the version or commit, and your OS

You should get a first reply within a week. Once a fix is released you will be
credited in the release notes, unless you would rather not be.

## Scope

In scope: the desktop app, the proxy and gateway, the Claude Code hook, the
control socket, config-file rewriting, and the optional catalogue service and
worker in this repository.

Known limits are documented rather than hidden. Bridge does not defend against
malware already running as your user, does not see tool use that bypasses it,
and its injection and secret detection are heuristic. See
[docs/limitations.md](docs/limitations.md) before reporting one of these as a
vulnerability; a way around a documented limit that the document does not
anticipate is still very welcome.
