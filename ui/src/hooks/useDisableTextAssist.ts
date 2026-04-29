import { useEffect } from "react";

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "",
]);

function shouldApply(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(el.type);
  }
  return false;
}

function apply(el: HTMLInputElement | HTMLTextAreaElement) {
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocomplete", "off");
  el.spellcheck = false;
}

function scan(root: ParentNode) {
  root.querySelectorAll("input, textarea").forEach((el) => {
    if (shouldApply(el)) apply(el);
  });
}

/**
 * Disable macOS autocorrect, auto-capitalize, autocomplete, and spellcheck
 * on every text input/textarea — including ones mounted later.
 */
export function useDisableTextAssist() {
  useEffect(() => {
    scan(document);
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (shouldApply(node)) apply(node);
          else scan(node);
        });
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
}
