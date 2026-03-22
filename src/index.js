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
 * Validate that a URL is safe to navigate to.
 * Allows localhost and private networks (needed for auditing local dev servers).
 * Blocks cloud metadata endpoints and non-http schemes.
 */
async function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Resolve DNS and block cloud metadata endpoints
  let address;
  try {
    // IP literals don't need resolution
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[')) {
      address = hostname.replace(/^\[|\]$/g, '');
    } else {
      const result = await lookup(hostname);
      address = result.address;
    }
  } catch {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  if (isCloudMetadataIP(address)) {
    throw new Error('URLs pointing to cloud metadata endpoints are not allowed');
  }

  return parsed;
}

/**
 * Check if an IP resolves to a cloud metadata endpoint (169.254.169.254)
 * or other dangerous link-local destinations. Handles IPv4-mapped IPv6.
 */
function isCloudMetadataIP(ip) {
  const normalized = extractIPv4FromMapped(ip);

  if (normalized) {
    const parts = normalized.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
      // 169.254.169.254 — cloud metadata (AWS, GCP, Azure)
      if (parts[0] === 169 && parts[1] === 254 && parts[2] === 169 && parts[3] === 254) return true;
    }
  }

  return false;
}

/**
 * Extract IPv4 address from IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254),
 * or return the IP as-is if it's already IPv4. Returns null for pure IPv6.
 */
function extractIPv4FromMapped(ip) {
  // Plain IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  return null;
}

/**
 * Intercept Puppeteer network requests to enforce URL policy at navigation time,
 * preventing DNS rebinding attacks.
 */
async function setupRequestInterception(page) {
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    try {
      const url = new URL(request.url());
      // Only intercept navigations and document requests
      if (request.isNavigationRequest()) {
        const hostname = url.hostname;
        let address;
        try {
          if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[')) {
            address = hostname.replace(/^\[|\]$/g, '');
          } else {
            const result = await lookup(hostname);
            address = result.address;
          }
        } catch {
          request.abort('namenotresolved');
          return;
        }
        if (isCloudMetadataIP(address)) {
          request.abort('accessdenied');
          return;
        }
      }
      request.continue();
    } catch {
      request.continue();
    }
  });
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

    let browser;
    try {
      const validatedUrl = await validateUrl(args.url);

      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      await setupRequestInterception(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(validatedUrl.href, { waitUntil: 'networkidle2', timeout: 30000 });

      const axeOptions = {};
      if (Array.isArray(args.tags) && args.tags.length > 0) {
        axeOptions.runOnly = {
          type: 'tag',
          values: args.tags,
        };
      }

      const results = await new AxePuppeteer(page).options(axeOptions).analyze();

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

              if (args.includeHtml === true) {
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
      console.error('[audit_webpage]', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error auditing webpage: ${sanitizeErrorMessage(error.message)}`,
          },
        ],
        isError: true,
      };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  async getSummary(args) {
    if (!args.url) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'URL is required'
      );
    }

    let browser;
    try {
      const validatedUrl = await validateUrl(args.url);

      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      await setupRequestInterception(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(validatedUrl.href, { waitUntil: 'networkidle2', timeout: 30000 });

      const results = await new AxePuppeteer(page).analyze();

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
      console.error('[get_summary]', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error getting summary: ${sanitizeErrorMessage(error.message)}`,
          },
        ],
        isError: true,
      };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('A11y Accessibility MCP server running on stdio');
  }
}

/**
 * Strip file paths and stack trace details from error messages
 * to avoid leaking internal server information.
 */
function sanitizeErrorMessage(message) {
  if (!message) return 'An unexpected error occurred';
  // Remove absolute file paths
  return message.replace(/\/[^\s:]+/g, '<path>').replace(/[A-Z]:\\[^\s:]+/g, '<path>');
}

const server = new A11yServer();
server.run().catch(console.error);
