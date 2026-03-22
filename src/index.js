#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { lookup } from 'node:dns/promises';
import puppeteer from 'puppeteer';
import { AxePuppeteer } from '@axe-core/puppeteer';

/**
 * Validate that a URL is safe to navigate to (SSRF protection).
 * Only allows http/https schemes and blocks requests to internal networks.
 */
async function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Block obvious localhost/loopback hostnames
  const blockedHostnames = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'];
  if (blockedHostnames.includes(hostname.toLowerCase())) {
    throw new Error('URLs pointing to loopback addresses are not allowed');
  }

  // Resolve the hostname and check the resulting IP
  let address;
  try {
    const result = await lookup(hostname);
    address = result.address;
  } catch {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  if (isPrivateIP(address)) {
    throw new Error('URLs pointing to private or internal network addresses are not allowed');
  }

  return parsed;
}

/**
 * Check if an IP address belongs to a private, loopback, or link-local range.
 */
function isPrivateIP(ip) {
  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
    // 127.0.0.0/8 — loopback
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 — private
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 — private
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 — private
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 — link-local / cloud metadata
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
  }

  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
  // IPv6 link-local
  if (ip.toLowerCase().startsWith('fe80:')) return true;
  // IPv6 unique local (fc00::/7)
  const first2 = ip.toLowerCase().slice(0, 2);
  if (first2 === 'fc' || first2 === 'fd') return true;

  return false;
}

class A11yServer {
  constructor() {
    this.server = new Server(
      {
        name: 'a11y-accessibility',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'audit_webpage',
          description: 'Perform an accessibility audit on a webpage',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the webpage to audit',
              },
              includeHtml: {
                type: 'boolean',
                description: 'Whether to include HTML snippets in the results',
                default: false,
              },
              tags: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Specific accessibility tags to check (e.g., wcag2a, wcag2aa, wcag21a, best-practice)',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'get_summary',
          description: 'Get a summary of accessibility issues for a webpage',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the webpage to audit',
              },
            },
            required: ['url'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'audit_webpage':
          return this.auditWebpage(request.params.arguments);
        case 'get_summary':
          return this.getSummary(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  async auditWebpage(args) {
    if (!args.url) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'URL is required'
      );
    }

    try {
      // Validate URL to prevent SSRF
      const validatedUrl = await validateUrl(args.url);

      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      // Set a reasonable viewport
      await page.setViewport({ width: 1280, height: 800 });

      // Navigate to the page using the validated URL
      await page.goto(validatedUrl.href, { waitUntil: 'networkidle2', timeout: 30000 });

      // Run axe on the page
      const axeOptions = {};
      if (args.tags && args.tags.length > 0) {
        axeOptions.runOnly = {
          type: 'tag',
          values: args.tags,
        };
      }
      
      const results = await new AxePuppeteer(page).options(axeOptions).analyze();
      
      // Close the browser
      await browser.close();
      
      // Format the results
      const formattedResults = {
        url: args.url,
        timestamp: new Date().toISOString(),
        violations: results.violations.map(violation => {
          const formattedViolation = {
            id: violation.id,
            impact: violation.impact,
            description: violation.description,
            helpUrl: violation.helpUrl,
            nodes: violation.nodes.map(node => {
              const formattedNode = {
                impact: node.impact,
                target: node.target,
                failureSummary: node.failureSummary,
              };
              
              if (args.includeHtml) {
                formattedNode.html = node.html;
              }
              
              return formattedNode;
            }),
          };
          
          return formattedViolation;
        }),
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        inapplicable: results.inapplicable.length,
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formattedResults, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error auditing webpage: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async getSummary(args) {
    if (!args.url) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'URL is required'
      );
    }

    try {
      // Validate URL to prevent SSRF
      const validatedUrl = await validateUrl(args.url);

      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      // Set a reasonable viewport
      await page.setViewport({ width: 1280, height: 800 });

      // Navigate to the page using the validated URL
      await page.goto(validatedUrl.href, { waitUntil: 'networkidle2', timeout: 30000 });

      // Run axe on the page
      const results = await new AxePuppeteer(page).analyze();
      
      // Close the browser
      await browser.close();
      
      // Create a summary
      const summary = {
        url: args.url,
        timestamp: new Date().toISOString(),
        totalIssues: results.violations.length,
        issuesBySeverity: {
          critical: results.violations.filter(v => v.impact === 'critical').length,
          serious: results.violations.filter(v => v.impact === 'serious').length,
          moderate: results.violations.filter(v => v.impact === 'moderate').length,
          minor: results.violations.filter(v => v.impact === 'minor').length,
        },
        topIssues: results.violations
          .sort((a, b) => {
            const impactOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
            return impactOrder[a.impact] - impactOrder[b.impact];
          })
          .slice(0, 5)
          .map(violation => ({
            id: violation.id,
            impact: violation.impact,
            description: violation.description,
            helpUrl: violation.helpUrl,
          })),
        passedTests: results.passes.length,
        incompleteTests: results.incomplete.length,
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting summary: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('A11y Accessibility MCP server running on stdio');
  }
}

const server = new A11yServer();
server.run().catch(console.error);
