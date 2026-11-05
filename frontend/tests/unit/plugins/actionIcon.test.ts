import { describe, expect, it } from "vitest";
import SVG_RULES from "~/plugins/action-icon-svg.json";
import { sanitizeActionIcon } from "~/plugins/actionIcon";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe("an SVG icon that a plugin contributes", () => {
  it("keeps the shapes, strokes and currentColor of a clean icon", () => {
    const svg = sanitizeActionIcon(
      `<svg ${NS} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 3v10M15 3v10"/><circle cx="8" cy="8" r="2" fill="#0af"/><g transform="translate(1, 2) rotate(45)"><rect width="4" height="4"/></g></svg>`,
    );
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="#0af"');
    expect(svg).toContain('transform="translate(1, 2) rotate(45)"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it.each([
    [
      "an escaped url",
      `<svg ${NS}><rect fill="\\75 rl(https://evil.example/p)"/></svg>`,
    ],
    [
      "another escaped url",
      `<svg ${NS}><rect stroke="u\\72l(https://evil.example/c)"/></svg>`,
    ],
    [
      "image-set",
      `<svg ${NS}><rect fill="image-set('https://evil.example/m.png' 1x)"/></svg>`,
    ],
    ["a local reference", `<svg ${NS}><rect fill="url(#g)"/></svg>`],
    ["an id", `<svg ${NS}><rect id="root"/></svg>`],
    ["a mask", `<svg ${NS}><rect mask="url(https://evil.example/m.png)"/></svg>`],
    [
      "a function in a path",
      `<svg ${NS}><path d="M0 0 url(https://evil.example/x)"/></svg>`,
    ],
    [
      "a function in a transform",
      `<svg ${NS}><g transform="url(https://evil.example/x)"/></svg>`,
    ],
  ])("drops the attribute with %s", (_name, input) => {
    const svg = sanitizeActionIcon(input);
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/evil|url|image-set|id=|mask|\\/);
  });

  it("drops gradients, masks and clip paths", () => {
    const svg = sanitizeActionIcon(
      `<svg ${NS}><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect/></clipPath></defs><rect width="1" height="1"/></svg>`,
    );
    expect(svg).not.toMatch(/defs|gradient|clippath|stop/i);
    expect(svg).toContain("<rect");
  });

  it.each([
    [
      "a script",
      `<svg ${NS}><script>alert(1)</script><path d="M0 0"/></svg>`,
      "script",
    ],
    [
      "an event handler",
      `<svg ${NS} onload="alert(1)"><path d="M0 0"/></svg>`,
      "onload",
    ],
    [
      "a foreign object",
      `<svg ${NS}><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>`,
      "onerror",
    ],
    [
      "a link",
      `<svg ${NS}><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>`,
      "javascript",
    ],
    [
      "an outside reference",
      `<svg ${NS}><use href="https://evil.example/a.svg#i"/></svg>`,
      "evil",
    ],
    [
      "an outside paint",
      `<svg ${NS}><rect fill="url(https://evil.example/p)"/></svg>`,
      "evil",
    ],
    [
      "a style",
      `<svg ${NS}><style>*{background:url(https://evil.example/x)}</style></svg>`,
      "evil",
    ],
    [
      "a style attribute",
      `<svg ${NS}><rect style="fill:url(https://evil.example/x)"/></svg>`,
      "evil",
    ],
  ])("removes %s", (_name, input, forbidden) => {
    const svg = sanitizeActionIcon(input);
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain(forbidden);
  });

  it.each([
    ["a DOCTYPE", `<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg ${NS}>&a;</svg>`],
    ["markup that is not an svg", `<div><svg ${NS}/></div>`],
    ["two roots", `<svg ${NS}/><svg ${NS}/>`],
    [
      "a file past the limit",
      `<svg ${NS}><desc>${"x".repeat(SVG_RULES.maxBytes)}</desc></svg>`,
    ],
  ])("refuses %s", (_name, input) => {
    expect(sanitizeActionIcon(input)).toBeNull();
  });
});
