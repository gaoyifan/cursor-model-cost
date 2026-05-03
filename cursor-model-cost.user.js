// ==UserScript==
// @name         Cursor Model Cost
// @namespace    https://cursor.com/
// @version      0.3.0
// @description  Show per-request model cost on Cursor usage and billing dashboards by intercepting the get-filtered-usage-events API and computing cost from input/output/cache-read/cache-write tokens.
// @author       yifan
// @match        https://cursor.com/dashboard/usage*
// @match        https://cursor.com/dashboard/billing*
// @match        https://www.cursor.com/dashboard/usage*
// @match        https://www.cursor.com/dashboard/billing*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * The Cursor dashboard renders a token total per row and shows the
 * input / output / cache-read / cache-write breakdown only via a hover
 * tooltip. Rather than scraping the tooltip DOM (which is fragile and
 * only populates on hover), this script patches `window.fetch` and
 * `XMLHttpRequest` at document-start to capture the JSON the dashboard
 * already fetches:
 *
 *   - /api/dashboard/get-filtered-usage-events — used by the Usage tab.
 *     Each `usageEvents[]` entry has `model`, `timestamp` (epoch ms as
 *     a string), and `tokenUsage` with `inputTokens`, `outputTokens`,
 *     `cacheReadTokens`, `cacheWriteTokens`.
 *
 *   - /api/dashboard/get-aggregated-usage-events — used by the Billing
 *     tab. Each `aggregations[]` entry has `modelIntent` and the same
 *     four token totals already aggregated for the current cycle.
 *
 * On the Usage page we match each table row to a captured event by the
 * full timestamp embedded in the Date cell's `title` attribute (e.g.
 * `May 4, 2026, 03:18:12 AM GMT+8`) plus the displayed model name.
 *
 * On the Billing page each row in the per-model table is matched by
 * model intent against the aggregated payload, so no extra requests
 * are made.
 *
 * Pricing sources (USD per 1M tokens):
 *   - GPT-5.5: input $5.00, cached input $0.50, output $30.00.
 *     OpenAI does not meter cache writes separately for GPT-5.5, so
 *     this script charges cache writes at the regular input rate.
 *     https://developers.openai.com/api/docs/models/gpt-5.5
 *   - Claude Opus 4.7: input $5.00, cache read $0.50, output $25.00,
 *     cache write $6.25 (5-minute TTL, the platform default).
 *     https://platform.claude.com/docs/en/about-claude/pricing
 *   - Composer 2 (standard): input $0.50, cache read $0.20, output $2.50.
 *   - Composer 2 fast (default in product): input $1.50, cache read $0.35,
 *     output $7.50. Cursor does not list a separate cache write rate for
 *     Composer 2, so cache writes are charged at the input rate.
 *     https://cursor.com/docs/models/cursor-composer-2
 */

(function () {
  "use strict";

  if (window.__cursorModelCostInstalled) return;
  window.__cursorModelCostInstalled = true;

  // ---------- Pricing (USD per 1,000,000 tokens) ----------
  const MODEL_PRICING = {
    "gpt-5.5": {
      input: 5.0,
      cacheWrite: 5.0,
      cacheRead: 0.5,
      output: 30.0,
    },
    "claude-opus-4.7": {
      input: 5.0,
      cacheWrite: 6.25,
      cacheRead: 0.5,
      output: 25.0,
    },
    "composer-2": {
      input: 0.5,
      cacheWrite: 0.5,
      cacheRead: 0.2,
      output: 2.5,
    },
    "composer-2-fast": {
      input: 1.5,
      cacheWrite: 1.5,
      cacheRead: 0.35,
      output: 7.5,
    },
  };

  // Map raw model strings (`gpt-5.5-medium`, `claude-opus-4-7-thinking-xhigh`,
  // `claude-opus-4.7`, `composer-2-fast`, ...) to a canonical pricing key.
  // Order matters; the first regex that matches wins. The `-fast` variant of
  // Composer 2 must be checked before the bare `composer-2` pattern.
  const MODEL_ALIASES = [
    [/^claude[-_]?opus[-_]?4[-._]?7\b/i, "claude-opus-4.7"],
    [/^gpt[-_]?5[-._]?5\b/i, "gpt-5.5"],
    [/^composer[-_]?2[-_]?fast\b/i, "composer-2-fast"],
    [/^composer[-_]?2\b/i, "composer-2"],
  ];

  function normalizeModel(rawModel) {
    const text = String(rawModel || "").trim().toLowerCase();
    for (const [pattern, key] of MODEL_ALIASES) {
      if (pattern.test(text)) return key;
    }
    return null;
  }

  function priceFor(rawModel) {
    const key = normalizeModel(rawModel);
    return key ? { key, pricing: MODEL_PRICING[key] } : null;
  }

  function costForTokens(rawModel, tokens) {
    const found = priceFor(rawModel);
    if (!found || !tokens) return null;
    const { key, pricing } = found;
    const input = Number(tokens.inputTokens || 0);
    const output = Number(tokens.outputTokens || 0);
    const cacheRead = Number(tokens.cacheReadTokens || 0);
    const cacheWrite = Number(tokens.cacheWriteTokens || 0);
    const total = input + output + cacheRead + cacheWrite;
    if (!total) return null;
    const cost =
      (input * pricing.input +
        output * pricing.output +
        cacheRead * pricing.cacheRead +
        cacheWrite * pricing.cacheWrite) /
      1_000_000;
    return {
      modelKey: key,
      pricing,
      tokens: { input, output, cacheRead, cacheWrite, total },
      cost,
    };
  }

  // ---------- Storage for captured data ----------
  // Per-event (from /api/dashboard/get-filtered-usage-events).
  const eventsByTimestamp = new Map();
  const eventsBySecondModel = new Map();
  // Per-model aggregates (from /api/dashboard/get-aggregated-usage-events),
  // keyed by raw model intent string (e.g. `gpt-5.5-medium`).
  const aggregatesByModel = new Map();

  function rememberEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    if (!ev.tokenUsage || !ev.timestamp || !ev.model) return;

    const tsString = String(ev.timestamp);
    if (eventsByTimestamp.has(tsString)) return;
    eventsByTimestamp.set(tsString, ev);

    const tsMs = Number(tsString);
    if (!Number.isFinite(tsMs)) return;
    const tsSec = Math.floor(tsMs / 1000);
    const modelKey = normalizeModel(ev.model) || ev.model.toLowerCase();
    const composite = `${tsSec}|${modelKey}`;
    if (!eventsBySecondModel.has(composite)) {
      eventsBySecondModel.set(composite, ev);
    }
  }

  function rememberAggregation(agg) {
    if (!agg || typeof agg !== "object") return;
    const model = agg.modelIntent || agg.model;
    if (!model) return;
    const tokens = {
      inputTokens: Number(agg.inputTokens || 0),
      outputTokens: Number(agg.outputTokens || 0),
      cacheReadTokens: Number(agg.cacheReadTokens || 0),
      cacheWriteTokens: Number(agg.cacheWriteTokens || 0),
    };
    aggregatesByModel.set(String(model), { model: String(model), tokenUsage: tokens });
  }

  function findUsageEventsInPayload(payload) {
    const stack = [payload];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === "object") {
            const isEvent =
              item.tokenUsage &&
              typeof item.tokenUsage === "object" &&
              item.timestamp != null &&
              item.model;
            if (isEvent) {
              rememberEvent(item);
              continue;
            }
            const isAggregation =
              (item.modelIntent || item.model) &&
              (item.inputTokens != null ||
                item.outputTokens != null ||
                item.cacheReadTokens != null ||
                item.cacheWriteTokens != null);
            if (isAggregation) {
              rememberAggregation(item);
              continue;
            }
            stack.push(item);
          }
        }
      } else {
        for (const key of Object.keys(node)) {
          stack.push(node[key]);
        }
      }
    }
  }

  function processCapturedJson(text) {
    if (!text || typeof text !== "string") return;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_err) {
      return;
    }
    const beforeEvents = eventsByTimestamp.size;
    const beforeAggregates = aggregatesByModel.size;
    findUsageEventsInPayload(parsed);
    if (
      eventsByTimestamp.size !== beforeEvents ||
      aggregatesByModel.size !== beforeAggregates
    ) {
      scheduleRender();
    }
  }

  // ---------- Patch fetch ----------
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const promise = originalFetch.apply(this, arguments);
      return promise.then(
        (response) => {
          try {
            const url = response && response.url ? response.url : "";
            const ct = response && response.headers && response.headers.get("content-type");
            if (
              url &&
              (ct == null || /json/i.test(ct)) &&
              /(filtered-usage-events|aggregated-usage-events|usage-events)/i.test(url)
            ) {
              response
                .clone()
                .text()
                .then(processCapturedJson)
                .catch(() => {});
            }
          } catch (_err) {
            /* ignore */
          }
          return response;
        },
        (err) => {
          throw err;
        },
      );
    };
  }

  // ---------- Patch XMLHttpRequest ----------
  const XhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XhrProto && XhrProto.open && XhrProto.send) {
    const originalOpen = XhrProto.open;
    const originalSend = XhrProto.send;
    XhrProto.open = function patchedOpen(method, url) {
      this.__cursorCostUrl = String(url || "");
      return originalOpen.apply(this, arguments);
    };
    XhrProto.send = function patchedSend() {
      const url = this.__cursorCostUrl || "";
      if (/(filtered-usage-events|aggregated-usage-events|usage-events)/i.test(url)) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") {
              processCapturedJson(this.responseText);
            } else if (this.responseType === "json" && this.response) {
              const before = eventsByTimestamp.size;
              findUsageEventsInPayload(this.response);
              if (eventsByTimestamp.size !== before) scheduleRender();
            }
          } catch (_err) {
            /* ignore */
          }
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  // ---------- Format helpers ----------
  function formatUsd(value) {
    if (value == null || !Number.isFinite(value)) return "-";
    if (value > 0 && value < 0.005) return "<$0.01";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  function formatTokens(n) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
  }

  function describeBreakdown(result) {
    const { modelKey, pricing, tokens, cost } = result;
    return [
      `${modelKey}: ${formatUsd(cost)}`,
      `input ${formatTokens(tokens.input)} × $${pricing.input}/1M`,
      `output ${formatTokens(tokens.output)} × $${pricing.output}/1M`,
      `cache read ${formatTokens(tokens.cacheRead)} × $${pricing.cacheRead}/1M`,
      `cache write ${formatTokens(tokens.cacheWrite)} × $${pricing.cacheWrite}/1M`,
    ].join("\n");
  }

  // ---------- Usage table (per-event) ----------
  const COST_ATTR = "data-cursor-cost";

  function findUsageTable() {
    return document.querySelector(
      'div[role="table"][aria-label*="Usage events"]',
    );
  }

  function ensureUsageHeader(table) {
    const headerRow = table.querySelector('div[role="row"].dashboard-table-header-row');
    if (!headerRow) return null;
    const headers = Array.from(headerRow.querySelectorAll(':scope > div[role="columnheader"]'));
    let costHeader = headers.find((h) => h.getAttribute(COST_ATTR) === "header");
    if (costHeader) return costHeader;
    const referenceHeader = headers[headers.length - 1];
    if (!referenceHeader) return null;
    costHeader = referenceHeader.cloneNode(false);
    costHeader.className = referenceHeader.className;
    costHeader.style.cssText = referenceHeader.style.cssText;
    costHeader.style.width = "120px";
    costHeader.style.flexShrink = "0";
    costHeader.style.flexGrow = "0";
    costHeader.setAttribute("role", "columnheader");
    costHeader.setAttribute(COST_ATTR, "header");
    if (!costHeader.classList.contains("dashboard-table-header-align-right")) {
      costHeader.classList.add("dashboard-table-header-align-right");
    }
    const span = document.createElement("span");
    span.className = "truncate min-w-0";
    span.textContent = "Cost";
    costHeader.replaceChildren(span);
    referenceHeader.after(costHeader);
    const aria = parseInt(table.getAttribute("aria-colcount") || "0", 10);
    if (aria) table.setAttribute("aria-colcount", String(aria + 1));
    const container = table.querySelector(".dashboard-table-container");
    if (container && container.style.minWidth) {
      const min = parseFloat(container.style.minWidth);
      if (Number.isFinite(min)) container.style.minWidth = `${min + 120}px`;
    }
    return costHeader;
  }

  function makeUsageCostCell(referenceCell) {
    const cell = referenceCell.cloneNode(false);
    cell.className = referenceCell.className;
    cell.style.cssText = referenceCell.style.cssText;
    cell.style.width = "120px";
    cell.style.flexShrink = "0";
    cell.style.flexGrow = "0";
    cell.style.fontVariantNumeric = "tabular-nums";
    if (!cell.classList.contains("dashboard-table-cell-align-right")) {
      cell.classList.remove("dashboard-table-cell-align-left");
      cell.classList.add("dashboard-table-cell-align-right");
    }
    cell.setAttribute("role", "cell");
    cell.setAttribute(COST_ATTR, "cell");
    return cell;
  }

  function colorForCost(cost) {
    if (cost == null || !Number.isFinite(cost)) return "var(--text-tertiary, inherit)";
    if (cost < 1) return "var(--text-tertiary, inherit)";
    return "var(--text-primary, inherit)";
  }

  function setCellResult(cell, result) {
    const text = result ? formatUsd(result.cost) : "-";
    const desiredTitle = result ? describeBreakdown(result) : "";
    const desiredColor = result ? colorForCost(result.cost) : "var(--text-tertiary, inherit)";
    if (cell.textContent !== text) {
      cell.replaceChildren(document.createTextNode(text));
    }
    if (cell.title !== desiredTitle) cell.title = desiredTitle;
    if (cell.style.color !== desiredColor) cell.style.color = desiredColor;
  }

  function lookupEventForRow(row) {
    const cells = Array.from(row.querySelectorAll(':scope > div[role="cell"]'));
    if (cells.length < 4) return null;
    const dateSpan = cells[0].querySelector("span[title]");
    const modelSpan = cells[2].querySelector("span[title]");
    if (!dateSpan || !modelSpan) return null;
    const dateText = dateSpan.getAttribute("title") || "";
    const modelText = modelSpan.getAttribute("title") || modelSpan.textContent || "";

    const parsedMs = Date.parse(dateText);
    if (!Number.isFinite(parsedMs)) return null;
    const tsSec = Math.floor(parsedMs / 1000);
    const modelKey = normalizeModel(modelText) || modelText.toLowerCase();

    // Try exact-second composite first; if not found, scan ±1s.
    for (const offset of [0, 1, -1, 2, -2]) {
      const key = `${tsSec + offset}|${modelKey}`;
      const ev = eventsBySecondModel.get(key);
      if (ev) return ev;
    }
    return null;
  }

  function renderUsageTable() {
    const table = findUsageTable();
    if (!table) return;
    ensureUsageHeader(table);
    const rows = table.querySelectorAll(
      'div[role="rowgroup"] > div[role="row"].dashboard-table-row',
    );
    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll(':scope > div[role="cell"]'));
      if (cells.length < 5) return;

      let costCell = cells.find((c) => c.getAttribute(COST_ATTR) === "cell");
      if (!costCell) {
        const reference = cells[cells.length - 1];
        costCell = makeUsageCostCell(reference);
        reference.after(costCell);
      }

      const event = lookupEventForRow(row);
      if (!event) {
        setCellResult(costCell, null);
        return;
      }
      const result = costForTokens(event.model, event.tokenUsage);
      setCellResult(costCell, result);
    });
  }

  // ---------- Billing page (aggregated per model) ----------
  // The billing page calls `/api/dashboard/get-aggregated-usage-events`
  // which already returns per-model token totals for the current cycle.
  // We just intercept that response and look the model up by raw name.

  function findBillingPricingTable() {
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll("thead th"));
      if (!headers.length) continue;
      const labels = headers.map((h) => h.textContent.trim().toLowerCase());
      if (
        labels.includes("item") &&
        labels.includes("tokens") &&
        labels.includes("requests")
      ) {
        return { table, labels, headers };
      }
    }
    return null;
  }

  function ensureBillingHeader(found) {
    const { headers, labels } = found;
    let costHeader = headers.find((h) => h.getAttribute(COST_ATTR) === "header");
    if (costHeader) return costHeader;
    const requestsIndex = labels.indexOf("requests");
    if (requestsIndex < 0) return null;
    const reference = headers[requestsIndex];
    costHeader = document.createElement("th");
    costHeader.scope = "col";
    costHeader.className = reference.className;
    costHeader.setAttribute(COST_ATTR, "header");
    costHeader.textContent = "Cost";
    reference.after(costHeader);
    return costHeader;
  }

  function billingModelFromRow(row, itemIndex) {
    const cells = Array.from(row.children);
    if (cells.length <= itemIndex) return null;
    const itemCell = cells[itemIndex];
    const inner = itemCell.querySelector(".text-secondary, .font-medium") || itemCell;
    const text = (inner.textContent || "").trim();
    if (!text || /^total$/i.test(text)) return null;
    return text;
  }

  function renderBillingTable() {
    const found = findBillingPricingTable();
    if (!found) return;
    if (!ensureBillingHeader(found)) return;
    const itemIndex = found.labels.indexOf("item");
    const requestsIndex = found.labels.indexOf("requests");
    const tbody = found.table.querySelector("tbody");
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll(":scope > tr"));
    let totalCost = 0;
    let supportedCount = 0;
    let totalRowCell = null;
    let totalRowSpanCell = null;
    rows.forEach((row) => {
      const cells = Array.from(row.children);
      if (!cells.length) return;

      const colspanCell = cells.find(
        (c) => parseInt(c.getAttribute("colspan") || "0", 10) >= 3,
      );
      if (colspanCell && cells.length === 1) {
        // Empty/info row that spans all columns; do not insert.
        return;
      }

      let costCell = cells.find((c) => c.getAttribute(COST_ATTR) === "cell");
      if (!costCell) {
        const ref = cells[Math.min(requestsIndex, cells.length - 1)];
        costCell = document.createElement("td");
        costCell.className = ref.className;
        costCell.setAttribute(COST_ATTR, "cell");
        costCell.style.fontVariantNumeric = "tabular-nums";
        costCell.style.textAlign = "right";
        ref.after(costCell);
      }

      const itemFirstCell = cells[itemIndex];
      const isTotalRow =
        itemFirstCell &&
        /^total$/i.test((itemFirstCell.textContent || "").trim());
      if (isTotalRow) {
        totalRowCell = costCell;
        return;
      }

      const modelText = billingModelFromRow(row, itemIndex);
      if (!modelText) {
        setBillingCellResult(costCell, null, null);
        return;
      }
      const aggregate = aggregatesByModel.get(modelText);
      if (!aggregate) {
        if (priceFor(modelText)) {
          setBillingCellResult(costCell, null, { pending: true });
        } else {
          setBillingCellResult(costCell, null, { unsupported: true });
        }
        return;
      }
      const result = costForTokens(aggregate.model, aggregate.tokenUsage);
      if (!result) {
        setBillingCellResult(costCell, null, { unsupported: true });
        return;
      }
      totalCost += result.cost;
      supportedCount += 1;
      setBillingCellResult(costCell, result.cost, result);
    });

    if (totalRowCell) {
      const haveData = aggregatesByModel.size > 0;
      if (supportedCount > 0) {
        const text = formatUsd(totalCost);
        if (totalRowCell.textContent !== text) totalRowCell.textContent = text;
        totalRowCell.title = "Sum of supported model costs.";
        const color = colorForCost(totalCost);
        if (totalRowCell.style.color !== color) totalRowCell.style.color = color;
      } else if (haveData) {
        if (totalRowCell.textContent !== "$0.00") totalRowCell.textContent = "$0.00";
        totalRowCell.title = "No supported models in this cycle.";
      } else {
        if (totalRowCell.textContent !== "...") totalRowCell.textContent = "...";
        totalRowCell.title = "Waiting for get-aggregated-usage-events response.";
      }
    }
  }

  function setBillingCellResult(cell, cost, info) {
    let text;
    let title = "";
    let color = "var(--text-primary, inherit)";
    if (cost != null) {
      text = formatUsd(cost);
      title = info
        ? describeBreakdown({
            modelKey: info.modelKey,
            pricing: info.pricing,
            tokens: info.tokens,
            cost: info.cost,
          })
        : "";
      color = colorForCost(cost);
    } else if (info && info.unsupported) {
      text = "n/a";
      title = "Pricing for this model is not configured in the script.";
      color = "var(--text-tertiary, inherit)";
    } else if (info && info.pending) {
      text = "...";
      title = "Waiting for get-aggregated-usage-events response.";
      color = "var(--text-tertiary, inherit)";
    } else {
      text = "-";
      color = "var(--text-tertiary, inherit)";
    }
    if (cell.textContent !== text) cell.textContent = text;
    if (cell.title !== title) cell.title = title;
    if (cell.style.color !== color) cell.style.color = color;
  }

  // ---------- Render scheduling ----------
  let renderTimer = 0;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = 0;
      try {
        renderUsageTable();
      } catch (err) {
        console.warn("[CursorModelCost] usage render failed", err);
      }
      try {
        renderBillingTable();
      } catch (err) {
        console.warn("[CursorModelCost] billing render failed", err);
      }
    }, 80);
  }

  function startObserving() {
    if (!document.body) {
      window.requestAnimationFrame(startObserving);
      return;
    }
    const observer = new MutationObserver((mutations) => {
      // Skip mutations our own renderer caused (changes to cells we own).
      const meaningful = mutations.some((m) => {
        if (m.type === "attributes") {
          if (
            m.target &&
            m.target.getAttribute &&
            m.target.getAttribute(COST_ATTR)
          ) {
            return false;
          }
          return true;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.getAttribute && node.getAttribute(COST_ATTR)) continue;
          return true;
        }
        for (const node of m.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.getAttribute && node.getAttribute(COST_ATTR)) continue;
          return true;
        }
        return false;
      });
      if (meaningful) scheduleRender();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy", "aria-rowcount"],
    });
    scheduleRender();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving, { once: true });
  } else {
    startObserving();
  }
})();
