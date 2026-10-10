/**
 * The curated directory of first-party MCP servers.
 *
 * Why this exists, and why it is not 500 entries:
 *
 * The public registry holds ~27,000 servers, but only ~7,400 are first-party
 * (the publisher's verified domain matches the endpoint host), and of those only
 * **34 belong to a company most people would recognise** — the rest are
 * MCP-hosting platforms and small startups. A "top 500 from top companies" list
 * cannot be assembled from the registry because those servers are not in it.
 *
 * Most large vendors run an MCP endpoint but never published it. So each entry
 * below was found by probing the vendor's own domain and confirmed by one of
 * two signals, both from the MCP spec rather than guesswork:
 *
 *   MCP-OAUTH  the endpoint answered with `WWW-Authenticate: Bearer` carrying
 *              OAuth protected-resource metadata, which only an MCP server
 *              behind the spec's auth flow emits. A bare 401/403 from a WAF was
 *              rejected — that is how datadoghq.com and sentry.io were excluded.
 *   MCP-OPEN   the endpoint answered the `initialize` handshake with JSON-RPC.
 *
 * Everything here is therefore checkable. What is *not* claimed: pricing (the
 * registry has no such field and neither do we) and ranking beyond the ordering
 * a human chose.
 */

export interface OfficialServer {
  /** Stable id; also the catalogue key when the registry has no entry. */
  id: string
  title: string
  /** The endpoint's own domain. This is what makes the entry first-party. */
  domain: string
  /**
   * Where to fetch the vendor's icon, when that differs from the endpoint
   * domain — Google serves MCP from googleapis.com, GitHub from
   * githubcopilot.com, and neither hosts the brand's favicon.
   */
  iconDomain?: string
  /**
   * An exact icon URL, for the few vendors whose best-resolution icon is not
   * their most recognisable one. Slack's apple-touch icon is a flat monochrome
   * glyph; the multi-colour mark people actually recognise is in its .ico.
   */
  iconUrl?: string
  url: string
  description: string
  category: string
  /** How the endpoint was confirmed, kept for display and for re-verification. */
  evidence: 'mcp-oauth' | 'mcp-open'
}

/** Verified by probe. Ordered roughly by how widely used the vendor is. */
export const OFFICIAL_SERVERS: OfficialServer[] = [
  // GitHub and Sentry serve MCP from a different domain than their main one,
  // so the `mcp.<domain>` convention misses them; both were confirmed by the
  // OAuth metadata header at the endpoints below.
  { id: 'off_github', title: 'GitHub', domain: 'githubcopilot.com', iconDomain: 'github.com', url: 'https://api.githubcopilot.com/mcp/', description: 'Repositories, issues, pull requests, actions and code search.', category: 'dev', evidence: 'mcp-oauth' },
  { id: 'off_sentry', title: 'Sentry', domain: 'sentry.dev', iconDomain: 'sentry.io', url: 'https://mcp.sentry.dev/mcp', description: 'Errors, issues, releases and performance data.', category: 'cloud', evidence: 'mcp-oauth' },
  // Google publishes one endpoint per product under googleapis.com; all five
  // answered the initialize handshake directly, no OAuth wall.
  { id: 'off_gdrive', title: 'Google Drive', domain: 'googleapis.com', iconDomain: 'google.com', url: 'https://drivemcp.googleapis.com/mcp/v1', description: 'Search, read and upload files across your Drive.', category: 'files', evidence: 'mcp-open' },
  { id: 'off_gmail', title: 'Gmail', domain: 'googleapis.com', iconDomain: 'google.com', url: 'https://gmailmcp.googleapis.com/mcp/v1', description: 'Draft replies, summarise threads and search your inbox.', category: 'comms', evidence: 'mcp-open' },
  { id: 'off_gcal', title: 'Google Calendar', domain: 'googleapis.com', iconDomain: 'google.com', url: 'https://calendarmcp.googleapis.com/mcp/v1', description: 'Manage your schedule and coordinate meetings.', category: 'productivity', evidence: 'mcp-open' },
  { id: 'off_gsheets', title: 'Google Sheets', domain: 'googleapis.com', iconDomain: 'google.com', url: 'https://sheetsmcp.googleapis.com/mcp/v1', description: 'Read, write and analyse spreadsheet data.', category: 'data', evidence: 'mcp-open' },
  { id: 'off_gdocs', title: 'Google Docs', domain: 'googleapis.com', iconDomain: 'google.com', url: 'https://docsmcp.googleapis.com/mcp/v1', description: 'Read, draft and edit documents.', category: 'productivity', evidence: 'mcp-open' },
  { id: 'off_atlassian', title: 'Atlassian', domain: 'atlassian.com', url: 'https://mcp.atlassian.com/v1/mcp', description: 'Jira and Confluence: issues, pages, projects and search.', category: 'productivity', evidence: 'mcp-oauth' },
  { id: 'off_slack', title: 'Slack', domain: 'slack.com', iconUrl: 'https://slack.com/favicon.ico', url: 'https://mcp.slack.com/mcp', description: 'Read and post messages, search channels and manage conversations.', category: 'comms', evidence: 'mcp-oauth' },
  { id: 'off_notion', title: 'Notion', domain: 'notion.com', url: 'https://mcp.notion.com/mcp', description: 'Pages, databases and comments across your Notion workspace.', category: 'productivity', evidence: 'mcp-oauth' },
  { id: 'off_figma', title: 'Figma', domain: 'figma.com', url: 'https://mcp.figma.com/mcp', description: 'Read design files, components and comments.', category: 'design', evidence: 'mcp-oauth' },
  { id: 'off_canva', title: 'Canva', domain: 'canva.com', url: 'https://mcp.canva.com/mcp', description: 'Design, edit and export Canva documents.', category: 'design', evidence: 'mcp-oauth' },
  { id: 'off_asana', title: 'Asana', domain: 'asana.com', url: 'https://mcp.asana.com/mcp', description: 'Tasks, projects, portfolios and workload.', category: 'productivity', evidence: 'mcp-oauth' },
  { id: 'off_linear', title: 'Linear', domain: 'linear.app', url: 'https://mcp.linear.app/mcp', description: 'Issues, cycles, projects and triage.', category: 'productivity', evidence: 'mcp-oauth' },
  { id: 'off_clickup', title: 'ClickUp', domain: 'clickup.com', url: 'https://mcp.clickup.com/mcp', description: 'Tasks, docs, goals and spaces.', category: 'productivity', evidence: 'mcp-oauth' },
  { id: 'off_monday', title: 'monday.com', domain: 'monday.com', url: 'https://mcp.monday.com/mcp', description: 'Boards, items, updates and automations.', category: 'productivity', evidence: 'mcp-oauth' },
  { id: 'off_airtable', title: 'Airtable', domain: 'airtable.com', url: 'https://mcp.airtable.com/mcp', description: 'Bases, tables, records and views.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_intercom', title: 'Intercom', domain: 'intercom.com', url: 'https://mcp.intercom.com/mcp', description: 'Conversations, contacts and help-centre content.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_hubspot', title: 'HubSpot', domain: 'hubspot.com', url: 'https://mcp.hubspot.com/', description: 'CRM contacts, companies, deals and tickets.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_stripe', title: 'Stripe', domain: 'stripe.com', url: 'https://mcp.stripe.com/', description: 'Payments, customers, subscriptions and invoices.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_paypal', title: 'PayPal', domain: 'paypal.com', url: 'https://mcp.paypal.com/mcp', description: 'Orders, payments, invoices and disputes.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_xero', title: 'Xero', domain: 'xero.com', url: 'https://mcp.xero.com/mcp', description: 'Accounting: invoices, contacts, bank transactions.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_ramp', title: 'Ramp', domain: 'ramp.com', url: 'https://mcp.ramp.com/mcp', description: 'Corporate cards, spend, bills and reimbursements.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_brex', title: 'Brex', domain: 'brex.com', url: 'https://api.brex.com/mcp', description: 'Cards, expenses, budgets and transactions.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_mercury', title: 'Mercury', domain: 'mercury.com', url: 'https://mcp.mercury.com/mcp', description: 'Business banking: accounts, transactions and payments.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_box', title: 'Box', domain: 'box.com', url: 'https://mcp.box.com/mcp', description: 'Files, folders, metadata and search.', category: 'files', evidence: 'mcp-oauth' },
  { id: 'off_dropbox', title: 'Dropbox', domain: 'dropbox.com', url: 'https://mcp.dropbox.com/mcp', description: 'Files, folders, sharing and search.', category: 'files', evidence: 'mcp-oauth' },
  { id: 'off_webflow', title: 'Webflow', domain: 'webflow.com', url: 'https://mcp.webflow.com/mcp', description: 'Sites, collections, CMS items and publishing.', category: 'web', evidence: 'mcp-oauth' },
  { id: 'off_wix', title: 'Wix', domain: 'wix.com', url: 'https://mcp.wix.com/mcp', description: 'Sites, content, products and bookings.', category: 'web', evidence: 'mcp-oauth' },
  { id: 'off_squarespace', title: 'Squarespace', domain: 'squarespace.com', url: 'https://mcp.squarespace.com/mcp', description: 'Sites, pages, commerce and domains.', category: 'web', evidence: 'mcp-open' },
  { id: 'off_klaviyo', title: 'Klaviyo', domain: 'klaviyo.com', url: 'https://mcp.klaviyo.com/mcp', description: 'Email and SMS campaigns, flows, lists and metrics.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_vercel', title: 'Vercel', domain: 'vercel.com', url: 'https://mcp.vercel.com/v1/mcp', description: 'Projects, deployments, domains and logs.', category: 'cloud', evidence: 'mcp-oauth' },
  { id: 'off_netlify', title: 'Netlify', domain: 'netlify.com', url: 'https://mcp.netlify.com/mcp', description: 'Sites, deploys, functions and environment variables.', category: 'cloud', evidence: 'mcp-oauth' },
  { id: 'off_cloudflare', title: 'Cloudflare', domain: 'cloudflare.com', url: 'https://mcp.cloudflare.com/mcp', description: 'Zones, DNS, Workers, R2 and analytics.', category: 'cloud', evidence: 'mcp-oauth' },
  { id: 'off_supabase', title: 'Supabase', domain: 'supabase.com', url: 'https://mcp.supabase.com/mcp', description: 'Projects, database, auth, storage and edge functions.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_neon', title: 'Neon', domain: 'neon.tech', url: 'https://mcp.neon.tech/mcp', description: 'Serverless Postgres: projects, branches and queries.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_mongodb', title: 'MongoDB', domain: 'mongodb.com', url: 'https://mcp.mongodb.com/mcp', description: 'Atlas clusters, collections, queries and indexes.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_posthog', title: 'PostHog', domain: 'posthog.com', url: 'https://mcp.posthog.com/mcp', description: 'Product analytics: events, insights, flags and replays.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_amplitude', title: 'Amplitude', domain: 'amplitude.com', url: 'https://mcp.amplitude.com/mcp', description: 'Product analytics: charts, cohorts and events.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_mixpanel', title: 'Mixpanel', domain: 'mixpanel.com', url: 'https://mcp.mixpanel.com/mcp', description: 'Events, funnels, retention and user profiles.', category: 'data', evidence: 'mcp-oauth' },
  { id: 'off_newrelic', title: 'New Relic', domain: 'newrelic.com', url: 'https://mcp.newrelic.com/mcp', description: 'APM, logs, traces, dashboards and alerts.', category: 'cloud', evidence: 'mcp-oauth' },
  { id: 'off_honeycomb', title: 'Honeycomb', domain: 'honeycomb.io', url: 'https://mcp.honeycomb.io/mcp', description: 'Observability: queries, triggers, SLOs and boards.', category: 'cloud', evidence: 'mcp-oauth' },
  { id: 'off_circleci', title: 'CircleCI', domain: 'circleci.com', url: 'https://mcp.circleci.com/v1/mcp', description: 'Pipelines, workflows, jobs and build logs.', category: 'dev', evidence: 'mcp-oauth' },
  { id: 'off_workos', title: 'WorkOS', domain: 'workos.com', url: 'https://mcp.workos.com/mcp', description: 'SSO, directory sync, organisations and audit logs.', category: 'dev', evidence: 'mcp-oauth' },
  { id: 'off_clerk', title: 'Clerk', domain: 'clerk.com', url: 'https://mcp.clerk.com/mcp', description: 'Users, sessions, organisations and auth config.', category: 'dev', evidence: 'mcp-open' },
  { id: 'off_algolia', title: 'Algolia', domain: 'algolia.com', url: 'https://mcp.algolia.com/mcp', description: 'Search indices, records, rules and analytics.', category: 'web', evidence: 'mcp-oauth' },
  { id: 'off_exa', title: 'Exa', domain: 'exa.ai', url: 'https://mcp.exa.ai/mcp', description: 'Neural web search and content retrieval.', category: 'web', evidence: 'mcp-open' },
  { id: 'off_firecrawl', title: 'Firecrawl', domain: 'firecrawl.dev', url: 'https://mcp.firecrawl.dev/mcp', description: 'Crawl and scrape sites into clean markdown.', category: 'web', evidence: 'mcp-open' },
  { id: 'off_browserbase', title: 'Browserbase', domain: 'browserbase.com', url: 'https://mcp.browserbase.com/mcp', description: 'Headless browser sessions for automation.', category: 'web', evidence: 'mcp-open' },
  { id: 'off_apify', title: 'Apify', domain: 'apify.com', url: 'https://mcp.apify.com/', description: 'Run scrapers and automation actors.', category: 'web', evidence: 'mcp-oauth' },
  { id: 'off_qdrant', title: 'Qdrant', domain: 'qdrant.tech', url: 'https://mcp.qdrant.tech/mcp', description: 'Vector search: collections, points and queries.', category: 'ai', evidence: 'mcp-open' },
  { id: 'off_replicate', title: 'Replicate', domain: 'replicate.com', url: 'https://mcp.replicate.com/mcp', description: 'Run and manage hosted machine-learning models.', category: 'ai', evidence: 'mcp-oauth' },
  { id: 'off_perplexity', title: 'Perplexity', domain: 'perplexity.ai', url: 'https://api.perplexity.ai/mcp', description: 'Search-grounded question answering.', category: 'ai', evidence: 'mcp-oauth' },
  { id: 'off_rippling', title: 'Rippling', domain: 'rippling.com', url: 'https://mcp.rippling.com/mcp', description: 'HR, payroll, devices and app access.', category: 'business', evidence: 'mcp-oauth' },
  { id: 'off_greenhouse', title: 'Greenhouse', domain: 'greenhouse.io', url: 'https://mcp.greenhouse.io/mcp', description: 'Jobs, candidates, applications and interviews.', category: 'business', evidence: 'mcp-oauth' }
]

/** Registry entries from recognisable companies, promoted rather than bundled. */
/**
 * Registry entries from recognisable companies, promoted rather than bundled.
 * Keys verified present in a full sync and confirmed first-party (the vendor's
 * verified namespace matches the endpoint host).
 */
export const OFFICIAL_REGISTRY_KEYS: string[] = [
  'com.gitlab/mcp',
  'co.huggingface/hf-mcp-server',
  'com.microsoft/microsoft-learn-mcp',
  'com.microsoft/sentinel-data-exploration',
  'com.nvidia.ngc.nsight.copilot.api/cuda-docs',
  'com.mux/mcp',
  'com.egnyte/mcp-server',
  'com.close/close-mcp',
  'io.prisma/mcp',
  'com.make/mcp-server',
  'com.statsig/statsig-mcp-server'
]

/** Icon domain for a bundled official entry, by catalogue key. */
export function officialIconDomain(key: string): string | null {
  const found = OFFICIAL_SERVERS.find((s) => s.id === key)
  return found ? (found.iconDomain ?? found.domain) : null
}

/** An exact icon URL for a curated entry, where one is pinned. */
export function officialIconUrl(key: string): string | null {
  return OFFICIAL_SERVERS.find((s) => s.id === key)?.iconUrl ?? null
}

/** The vendor domain for a curated entry, for the "made by" line. */
export function officialVendor(key: string): string | null {
  const found = OFFICIAL_SERVERS.find((s) => s.id === key)
  return found ? (found.iconDomain ?? found.domain) : null
}

/** The category a curated entry belongs to. */
export function officialCategory(key: string): string | null {
  return OFFICIAL_SERVERS.find((s) => s.id === key)?.category ?? null
}

/**
 * True when a curated endpoint answered with an OAuth challenge. Such servers
 * declare no credential fields — the flow is interactive — so this is the only
 * way to know sign-in is required.
 */
export function officialRequiresAuth(key: string): boolean {
  return OFFICIAL_SERVERS.some((s) => s.id === key && s.evidence === 'mcp-oauth')
}

export const OFFICIAL_TAG = 'official'
export const OFFICIAL_VERSION = '9'
