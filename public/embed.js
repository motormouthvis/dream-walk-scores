/**
 * Dream Walk Scores — embeddable widget SDK.
 *
 * One script tag on a partner page produces either a floating popup or an inline panel
 * showing Walk, Bike and Transit scores for the property on that page.
 *
 *   <script src="https://<host>/embed.js" async></script>
 *
 * Add a container to render inline instead of as a popup:
 *
 *   <div id="dream-walk-scores"></div>
 *
 * Deliberately a plain IIFE with no build step and no dependencies. It is served to third
 * party sites we do not control, so it must be small, must not touch globals beyond one
 * namespaced flag, and must fail silently rather than break someone's listing page.
 */
(function () {
  "use strict";

  // A partner who pastes the snippet twice should still get one widget.
  if (window.__DREAM_WALK_SCORES_LOADED__) return;
  window.__DREAM_WALK_SCORES_LOADED__ = true;

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf("embed.js") !== -1) return all[i];
    }
    return null;
  })();

  if (!script) return;

  var API_BASE = script.getAttribute("data-api-base") || new URL(script.src).origin;

  var INLINE_SELECTORS = [
    "#dream-walk-scores",
    ".dream-walk-scores",
    "[data-dream-walk-scores]",
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function attr(name, fallback) {
    var value = script.getAttribute("data-" + name);
    return value === null || value === "" ? fallback : value;
  }

  function bool(name, fallback) {
    var value = script.getAttribute("data-" + name);
    if (value === null) return fallback;
    return value === "" || value === "1" || value === "true";
  }

  function on(target, event, handler) {
    target.addEventListener(event, handler, false);
  }

  function request(method, path, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, API_BASE + path, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.timeout = 15000;
    xhr.onload = function () {
      var parsed = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch (error) {
        /* leave null; the caller treats it as a failure */
      }
      done(xhr.status >= 200 && xhr.status < 300 ? parsed : null);
    };
    xhr.onerror = function () { done(null); };
    xhr.ontimeout = function () { done(null); };
    try {
      xhr.send(body ? JSON.stringify(body) : null);
    } catch (error) {
      done(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Page scraping
  // ---------------------------------------------------------------------------

  /** Elements a listing page plausibly puts its address in. */
  var ADDRESS_SELECTORS = [
    "[itemprop='streetAddress']",
    "[itemprop='address']",
    ".address",
    ".listing-address",
    ".property-address",
    "[class*='address']",
    "h1",
    "h2",
  ];

  function collectPageSignals() {
    var jsonLd = [];
    var blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < blocks.length && i < 10; i++) {
      if (blocks[i].textContent) jsonLd.push(blocks[i].textContent.slice(0, 20000));
    }

    var meta = {};
    var tags = document.getElementsByTagName("meta");
    for (var j = 0; j < tags.length; j++) {
      var key = tags[j].getAttribute("property") || tags[j].getAttribute("name");
      var content = tags[j].getAttribute("content");
      if (key && content) meta[key.toLowerCase()] = content.slice(0, 500);
    }

    var candidates = [];
    for (var k = 0; k < ADDRESS_SELECTORS.length && candidates.length < 25; k++) {
      var found = document.querySelectorAll(ADDRESS_SELECTORS[k]);
      for (var m = 0; m < found.length && candidates.length < 25; m++) {
        var text = (found[m].textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 8 && text.length < 300) candidates.push(text);
      }
    }

    return {
      pageUrl: location.href,
      pageTitle: document.title,
      host: location.hostname,
      jsonLd: jsonLd,
      meta: meta,
      candidates: candidates,
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function iframeUrl(config, resolved) {
    var params = [];
    if (resolved && resolved.lat != null && resolved.lng != null) {
      params.push("lat=" + encodeURIComponent(resolved.lat));
      params.push("lng=" + encodeURIComponent(resolved.lng));
    }
    if (resolved && resolved.address) {
      params.push("address=" + encodeURIComponent(resolved.address));
    }
    params.push("accent=" + encodeURIComponent((config.accentColor || "#1fa55f").replace("#", "")));
    if (config.showHeader) params.push("header=1");
    return API_BASE + "/embed?" + params.join("&");
  }

  /**
   * Track frames that have asked to be resized.
   *
   * An iframe cannot size itself, and a fixed height is wrong in both directions: too
   * short clips the summary, too tall leaves dead space in the middle of a partner's
   * listing. The embedded page posts its content height and we apply it here.
   */
  var managedFrames = [];

  on(window, "message", function (event) {
    var data = event.data;
    if (!data || data.type !== "dws:height" || typeof data.height !== "number") return;

    for (var i = 0; i < managedFrames.length; i++) {
      var entry = managedFrames[i];
      // Only resize the frame that sent the message; a page may host several widgets.
      if (entry.frame.contentWindow !== event.source) continue;
      // Clamp: a bug at either end should not blank the widget or blow out the page.
      var height = Math.max(entry.minHeight, Math.min(4000, Math.ceil(data.height)));
      entry.frame.style.height = height + "px";
    }
  });

  function buildIframe(src, minHeight) {
    var frame = document.createElement("iframe");
    frame.src = src;
    frame.title = "Walk, Bike and Transit scores";
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("scrolling", "no");
    frame.style.cssText =
      "width:100%;border:0;display:block;background:transparent;" +
      "height:" + minHeight + "px;transition:height .2s ease;";
    managedFrames.push({ frame: frame, minHeight: minHeight });
    return frame;
  }

  function renderInline(container, config, resolved) {
    container.innerHTML = "";
    container.appendChild(
      buildIframe(iframeUrl(config, resolved), parseInt(attr("min-height", "420"), 10) || 420)
    );
  }

  function renderPopup(config, resolved) {
    var accent = config.accentColor || "#1fa55f";
    var side = config.position === "left" ? "left" : "right";
    var offset = parseInt(config.bottomOffset, 10) || 20;

    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Show walk, bike and transit scores");
    button.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="4.5" r="2"/><path d="M9 20l1.5-6L8 11l1-4 4 1 2 3"/><path d="M13 14l3 6"/></svg>';
    button.style.cssText =
      "position:fixed;bottom:" + offset + "px;" + side + ":20px;z-index:2147483000;" +
      "width:52px;height:52px;border-radius:50%;border:0;cursor:pointer;" +
      "background:" + accent + ";box-shadow:0 4px 16px rgba(0,0,0,.24);" +
      "display:flex;align-items:center;justify-content:center;padding:0;";

    var panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;bottom:" + (offset + 64) + "px;" + side + ":20px;z-index:2147483000;" +
      "width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - " + (offset + 90) + "px);" +
      "background:#fff;border-radius:14px;overflow:hidden;display:none;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.22);";

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.style.cssText =
      "position:absolute;top:6px;" + side + ":10px;z-index:2;border:0;background:transparent;" +
      "font-size:24px;line-height:1;cursor:pointer;color:#6b7280;padding:4px 8px;";

    var loaded = false;
    function toggle() {
      var opening = panel.style.display === "none";
      panel.style.display = opening ? "block" : "none";
      button.setAttribute("aria-expanded", opening ? "true" : "false");
      // Defer the iframe until first open so the widget costs a partner page nothing
      // until a visitor actually asks for it.
      if (opening && !loaded) {
        loaded = true;
        panel.appendChild(buildIframe(iframeUrl(config, resolved), 520));
      }
    }

    on(button, "click", toggle);
    on(close, "click", toggle);
    on(document, "keydown", function (event) {
      if (event.key === "Escape" && panel.style.display === "block") toggle();
    });

    panel.appendChild(close);
    document.body.appendChild(panel);
    document.body.appendChild(button);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function findInlineContainer() {
    for (var i = 0; i < INLINE_SELECTORS.length; i++) {
      var element = document.querySelector(INLINE_SELECTORS[i]);
      if (element) return element;
    }
    return null;
  }

  function start() {
    request("GET", "/api/embed/config?host=" + encodeURIComponent(location.hostname), null, function (remote) {
      var config = remote || {};

      if (config.enabled === false) return;

      // Attributes on the script tag win over the server config, so a partner can
      // override a single page without touching their account.
      config.accentColor = attr("accent-color", config.accentColor || "#1fa55f");
      config.position = attr("position", config.position || "right");
      config.bottomOffset = attr("bottom-offset", config.bottomOffset || 20);
      config.showHeader = bool("show-header", config.showHeader !== false);

      var explicitLat = attr("lat", null);
      var explicitLng = attr("lng", null);
      var explicitAddress = attr("address", null);

      function render(resolved) {
        var container = findInlineContainer();
        if (container) renderInline(container, config, resolved);
        else renderPopup(config, resolved);
      }

      if (explicitLat && explicitLng) {
        render({ lat: explicitLat, lng: explicitLng, address: explicitAddress });
        return;
      }
      if (explicitAddress) {
        render({ address: explicitAddress });
        return;
      }

      request("POST", "/api/embed/scrape", collectPageSignals(), function (scraped) {
        if (scraped && scraped.found) {
          render(scraped);
        } else if (bool("require-address", false)) {
          // The partner would rather show nothing than a manual-entry prompt.
          return;
        } else {
          // Render with no address; the iframe shows its own search box.
          render(null);
        }
      });
    });
  }

  if (document.readyState === "loading") {
    on(document, "DOMContentLoaded", start);
  } else {
    start();
  }
})();
