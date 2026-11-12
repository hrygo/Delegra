/**
 * Public marketing and commerce services outside Delegra's intranet catalog.
 * This is only a Browse preference: saved applications and connections remain
 * visible, and neither the server catalog nor execution permissions are changed.
 * Keep uncertain entries and model providers visible until their use is known.
 */
export const DELEGRA_HIDDEN_CONNECTOR_SLUGS = new Set([
  "adobe-marketing-agent-mcp",
  "cashfree-payments-mcp",
  "doppler-marketing-automation",
  "gauge",
  "googleads",
  "gsc-wizard",
  "hubspot-marketing-api",
  "lightspeed",
  "linkedin-ads",
  "metaads",
  "pinterest-ads",
  "reddit-ads",
  "shopify",
  "stripe",
  "tiktok-ads",
  "windsor-ai",
]);
