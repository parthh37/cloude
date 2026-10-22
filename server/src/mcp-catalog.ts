import type { McpCatalogEntry } from '../../shared/protocol.js';

/**
 * One-click MCP servers for Settings → MCP. Adding one writes its `config` into
 * AppSettings.mcpServers with `${VAR}` placeholders. Cloude never substitutes
 * them: the SDK passes MCP config to Claude Code on its command line, and Claude
 * Code expands `${VAR}` itself from its environment (which carries the encrypted
 * Cloude secrets) — so tokens stay out of settings *and* out of argv.
 * Secrets for stdio servers go in `env`, never in `args` (a child's argv is world-readable).
 *
 * Prefer token-based (stdio or header-authenticated) servers: OAuth-only remote
 * servers need an interactive sign-in, which you'd do from a Claude CLI terminal.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date, version-specific library documentation and code examples, pulled into context on demand.',
    category: 'code',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
    envKeys: [],
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search, Actions runs and reviews through GitHub’s official MCP server.',
    category: 'code',
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GH_TOKEN}' } },
    envKeys: ['GH_TOKEN'],
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    description: 'Official .NET, C#, Azure and Windows docs — trustworthy answers for .NET development.',
    category: 'code',
    config: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' },
    envKeys: [],
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: 'Performance traces, network inspection, console and Lighthouse-style audits in a real Chrome (complements Playwright).',
    category: 'browser',
    config: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated'] },
    envKeys: [],
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    id: 'database',
    name: 'Databases (DBHub)',
    description: 'Query and inspect Postgres, MySQL, MariaDB, SQL Server or SQLite. Set DATABASE_URL as a project secret.',
    category: 'data',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub', '--transport', 'stdio'], env: { DSN: '${DATABASE_URL}' } },
    envKeys: ['DATABASE_URL'],
    docsUrl: 'https://github.com/bytebase/dbhub',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    description: 'Structured step-by-step reasoning scratchpad for hard design and debugging problems.',
    category: 'reasoning',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    envKeys: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch web pages and convert them to clean markdown.',
    category: 'browser',
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    envKeys: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and news search with a Brave Search API key.',
    category: 'browser',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } },
    envKeys: ['BRAVE_API_KEY'],
    docsUrl: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: 'Inspect and manage clusters from the server’s kubeconfig (pods, logs, deployments, Helm).',
    category: 'cloud',
    config: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-server-kubernetes'] },
    envKeys: [],
    docsUrl: 'https://github.com/Flux159/mcp-server-kubernetes',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Pull errors, stack traces and releases from Sentry while debugging.',
    category: 'productivity',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_ACCESS_TOKEN: '${SENTRY_ACCESS_TOKEN}' } },
    envKeys: ['SENTRY_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and update Notion pages and databases (specs, roadmaps, docs).',
    category: 'productivity',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: '${NOTION_TOKEN}' } },
    envKeys: ['NOTION_TOKEN'],
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Work with Stripe objects and docs. Use a restricted or test-mode key.',
    category: 'cloud',
    config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer ${STRIPE_SECRET_KEY}' } },
    envKeys: ['STRIPE_SECRET_KEY'],
    docsUrl: 'https://docs.stripe.com/mcp',
  },
];

