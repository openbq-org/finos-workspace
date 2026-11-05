import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import SVG_RULES from "./action-icon-svg.json";
import { loadAsset } from "./bundle";
import type { AvailablePlugin } from "./types";

const VALUE_PATTERNS = new Map(
  Object.entries(SVG_RULES.values).map(([name, pattern]) => [
    name.toLowerCase(),
    new RegExp(`^(?:${pattern})$`),
  ]),
);

let purifier: ReturnType<typeof DOMPurify> | null = null;

function svgPurifier() {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const pattern = VALUE_PATTERNS.get(data.attrName.toLowerCase());
    if (!pattern?.test(data.attrValue.trim())) data.keepAttr = false;
  });
  return purifier;
}

export function sanitizeActionIcon(text: string): string | null {
  if (new TextEncoder().encode(text).byteLength > SVG_RULES.maxBytes) return null;
  if (/<!(DOCTYPE|ENTITY)/i.test(text)) return null;
  const clean = svgPurifier().sanitize(text, {
    ALLOWED_TAGS: SVG_RULES.tags.map((tag) => tag.toLowerCase()),
    ALLOWED_ATTR: Object.keys(SVG_RULES.values).map((name) => name.toLowerCase()),
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: false,
    RETURN_DOM_FRAGMENT: true,
  });
  const [root, ...rest] = [...clean.childNodes].filter(
    (node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim(),
  );
  if (!root || rest.length || root.nodeName.toLowerCase() !== "svg") return null;
  const svg = root as SVGSVGElement;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg.outerHTML;
}

const icons = new Map<string, Promise<string | null>>();

export function useActionIcon(plugin: AvailablePlugin, path: string | undefined) {
  const [markup, setMarkup] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    const key = `${plugin.id}/${plugin.digest}/${path}`;
    let pending = icons.get(key);
    if (!pending) {
      pending = loadAsset(plugin, path)
        .then((bytes) => sanitizeActionIcon(new TextDecoder().decode(bytes)))
        .catch(() => null);
      icons.set(key, pending);
    }
    let current = true;
    pending.then((value) => {
      if (current) setMarkup(value);
    });
    return () => {
      current = false;
    };
  }, [plugin, path]);
  return path ? markup : null;
}
