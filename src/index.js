#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import puppeteer from 'puppeteer';
import { AxePuppeteer } from '@axe-core/puppeteer';
import { createAuditProxy, parseUrl, resolveTarget } from './network.js';

function validateArgs(args) {
  if (!args || typeof args.url !== 'string' || args.url.length > 8192 ||
      (args.includeHtml !== undefined && typeof args.includeHtml !== 'boolean') ||
      (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.length > 32 ||
        args.tags.some(tag => typeof tag !== 'string' || tag.length > 100)))) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid audit arguments');
  }
}

class A11yServer {
  constructor() {
    this.server = new Server(
      {
        name: 'a11y-accessibility',
        version: '1.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.auditRunning = false;
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
    validateArgs(args);
    if (this.auditRunning) throw new McpError(ErrorCode.InvalidRequest, 'An audit is already running');
    this.auditRunning = true;
    let browser, proxy, timer;
    try {
      const allowLoopback = process.env.AUDIT_ALLOW_LOOPBACK !== 'false';
      const validatedUrl = parseUrl(args.url);
      await resolveTarget(validatedUrl.hostname, allowLoopback);
      proxy = await createAuditProxy(allowLoopback);
      browser = await puppeteer.launch({
        headless: true,
        args: [`--proxy-server=http://127.0.0.1:${proxy.port}`,
          '--proxy-bypass-list=<-loopback>', '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
      timer = setTimeout(() => { void browser.close().catch(() => {}); }, 90_000);
      const page = await browser.newPage();
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const scheme = new URL(request.url()).protocol;
        void (['http:', 'https:', 'data:', 'blob:', 'about:'].includes(scheme)
          ? request.continue() : request.abort('accessdenied')).catch(() => {});
      });
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
      clearTimeout(timer);
      try { await browser?.close().catch(() => {}); }
      finally {
        try { await proxy?.close(); }
        finally { this.auditRunning = false; }
      }
    }
  }

  async getSummary(args) {
    validateArgs(args);
    if (this.auditRunning) throw new McpError(ErrorCode.InvalidRequest, 'An audit is already running');
    this.auditRunning = true;
    let browser, proxy, timer;
    try {
      const allowLoopback = process.env.AUDIT_ALLOW_LOOPBACK !== 'false';
      const validatedUrl = parseUrl(args.url);
      await resolveTarget(validatedUrl.hostname, allowLoopback);
      proxy = await createAuditProxy(allowLoopback);
      browser = await puppeteer.launch({
        headless: true,
        args: [`--proxy-server=http://127.0.0.1:${proxy.port}`,
          '--proxy-bypass-list=<-loopback>', '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
      timer = setTimeout(() => { void browser.close().catch(() => {}); }, 90_000);
      const page = await browser.newPage();
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const scheme = new URL(request.url()).protocol;
        void (['http:', 'https:', 'data:', 'blob:', 'about:'].includes(scheme)
          ? request.continue() : request.abort('accessdenied')).catch(() => {});
      });
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
      clearTimeout(timer);
      try { await browser?.close().catch(() => {}); }
      finally {
        try { await proxy?.close(); }
        finally { this.auditRunning = false; }
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
