import type { UserThemeConfig } from "@docusaurus/theme-common";
import type { Config } from "@docusaurus/types";
import llms from "./plugins/llms.ts";

const title = "FINOS Workspace";
const tagline =
  "An open, self-hosted analytics workspace for financial institutions to connect data, tools, and AI agents.";

const config: Config = {
  title,
  tagline,
  favicon: "img/logo.svg",
  url: process.env.URL || "http://localhost:3100",
  baseUrl: "/",
  trailingSlash: false,
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  plugins: [
    [
      "@docusaurus/plugin-content-docs",
      {
        path: "../docs",
        routeBasePath: "/",
        sidebarPath: "./sidebars.ts",
        exclude: [
          "examples/**",
          "**/_*.{js,jsx,ts,tsx,md,mdx}",
          "**/_*/**",
          "**/*.test.{js,jsx,ts,tsx}",
          "**/__tests__/**",
        ],
      },
    ],
    llms,
  ],
  themes: [
    ["@docusaurus/theme-classic", { customCss: "./src/css/custom.css" }],
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        docsDir: "../docs",
        docsRouteBasePath: "/",
        indexBlog: false,
        language: "en",
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    metadata: [
      { name: "description", content: tagline },
      { property: "og:title", content: title },
      { property: "og:description", content: tagline },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: tagline },
    ],
    navbar: {
      logo: {
        alt: "FINOS Workspace",
        src: "img/logo-horizontal-color.svg",
        srcDark: "img/logo-horizontal-white.svg",
        height: 26,
      },
      items: [
        { type: "docSidebar", sidebarId: "quickStart", label: "Quick Start", position: "left" },
        { type: "docSidebar", sidebarId: "features", label: "Features", position: "left" },
        { type: "docSidebar", sidebarId: "concepts", label: "Concepts", position: "left" },
        { type: "docSidebar", sidebarId: "tutorials", label: "Tutorials", position: "left" },
        { type: "docSidebar", sidebarId: "reference", label: "Reference", position: "left" },
        { href: "https://github.com/finos-labs/finos-workspace", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      copyright: "Licensed under the Apache License 2.0.",
      links: [
        { label: "FINOS Website", href: "https://www.finos.org/" },
        { label: "Community Handbook", href: "https://community.finos.org/" },
        { label: "FINOS Projects", href: "https://landscape.finos.org" },
        { label: "FINOS Projects on GitHub", href: "https://github.com/finos" },
        { label: "Engage the FINOS Community", href: "https://www.finos.org/engage-with-our-community" },
        { label: "FINOS News and Events", href: "https://www.finos.org/news-and-events" },
      ],
    },
    prism: {
      additionalLanguages: ["bash", "json", "yaml", "docker"],
    },
  } satisfies UserThemeConfig,
};

export default config;
